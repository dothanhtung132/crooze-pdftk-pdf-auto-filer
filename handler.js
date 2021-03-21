'use strict';

var pdfFiller = require('pdffiller-aws-lambda');
var csv = require('jquery-csv');

const _ = require('lodash');
var DIR_NAME = '/tmp/';

const os = require('os');
const fs = require('fs');

const BoxSDK = require('box-node-sdk');
// const boxConfig = JSON.parse(process.env.BOX_CONFIG);
// const boxSdk = BoxSDK.getPreconfiguredInstance(boxConfig);
// const _boxClient = boxSdk.getAppAuthClient('enterprise');
// _boxClient.asUser(process.env.BOX_USER_ID);

const child_process = require('child_process');
const execFile = require('child_process').execFile;

const PDFParser = require("pdf2json");

const PDFDocument = require('pdfkit');

// var xmlParser = require('xml2json');
//var xmlParser = require('xml2json-light');
var StringDecoder = require('string_decoder').StringDecoder;

var _parentFolderId;
var _signatureFieldId;
var _signaturePageIndex;
var _boxClient;

var headers = {
	"content-type": "application/json",
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Credentials': true
}

const boxSdk = new BoxSDK({clientID: 'box client id', clientSecret: 'box client secret key'});

module.exports.generateCertificate = async (event, context) => {
	if (event.headers.Origin == 'https://local.crooze.com') {
		DIR_NAME = 'tmp/'
		process.env['PATH'] = process.env['PATH'] + ':' + '/usr/local/bin'
		process.env['LD_LIBRARY_PATH'] = '/usr/local/bin'
	}
	var currentTime = new Date().getTime();
	var sourcePDF = DIR_NAME + 'certificate_template_file.pdf';
	var fileName = 'certificate' + currentTime + '.pdf';
	var destinationPDF = DIR_NAME + fileName;


	var requestParams = getRequestParams(event);
	console.log('requestParams: ', requestParams);

	var token = requestParams.token;
	_boxClient = boxSdk.getBasicClient(token);


	var parentFolder = requestParams.folderData;
	_parentFolderId = parentFolder ? parentFolder.boxid : process.env.CERTIFICATE_OUTPUT_FOLDER;

	var formData = requestParams.formData;

	var controlFile = requestParams.controlFile;
	if (!controlFile) {
		var message = 'Control File is missing';
		return showError(message);
	}

	var controlFileData;
	var result = await getFileContent(controlFile.boxid, 'controlFile.json')
	.then(fileData => {
		try {
			controlFileData = JSON.parse(fileData);
			removeJSONComment(controlFileData);
		} catch (err) {
			console.log("readFile err: ", err);
			var errMessage = 'Cannot read file content';
			var result = {
				type: 'error',
				status: 101,
				message: errMessage
			};
			return result;
		}
	})
	.catch(err => {
		var message = 'Control File does not exist inside output folder';
		return showError(message);
	});
	if (result && result.type == 'error') {
		var message = result.message;
		return showError(message);
	}

	if (!controlFileData) {
		return showError('Cannot read Control File content');
	}

	_signatureFieldId = controlFileData["pdfSignatureField"] || process.env.CERTIFICATE_SIGNATURE_FIELD;
	var templateKey = controlFileData["templateKey"] || requestParams.templateKey;

	var formMapping = controlFileData["formMapping"];
	var formDataFormat = controlFileData["formDataFormat"];
	var formattedFormFields = {};

	for (var key in formMapping) {
		var formMappingValue = formMapping[key];
		var formValue = formData[formMappingValue];
		if (!formValue) continue;
		var formDataFormatItem = formDataFormat[formMappingValue] || {};
		var regex = formDataFormatItem.regex;
		if (regex) {
			var matchs = formValue.match(new RegExp(regex));
			if (matchs && matchs.length > 0) {
				formValue = matchs[0];
			}
		}
		formattedFormFields[key] = formValue;
	}

	var validation = controlFileData["validation"];
	if (!validation) {
		return showError('Validation configure is missing');
	}
	var validationData = validation.data || [];

	var pdfFillData = {};
	var folderList = [];
	var combinedPDF;
	var certificateFile;
	var fillData = {};

	//var fileId = process.env.CERTIFICATE_PDF_TEMPLATE_BOXID;
	var certificateFileId = controlFileData["certificateFileId"] || process.env.CERTIFICATE_PDF_TEMPLATE_BOXID;
	if (!certificateFileId) {
		var message = 'Certificate File is missing';
		return showError(message);
	}

	var fieldObj;
	var response = await readStreamToFile(certificateFileId, sourcePDF)
		.then(filePath => {
			return parseCSVDataFromFiles(validationData);
		})
		.then(results => {
			var invalidItems = [];
			_.each(results, function(item){
				var checkResult = checkItemValidation(item, formattedFormFields);
				var success = checkResult.success
				if (success) {
					var rowData = checkResult.rowData;
					_.extend(fillData, rowData);
				} else {
					var errMessage = checkResult.errMessage;
					var result = {
						type: 'error',
						status: 101,
						message: errMessage
					};
					throw result;
				}
			});

			console.log("formData: ", formData);

			fillData = _.extend(formData, fillData);

			console.log("fillData: ", fillData);

			//replace value in pdfMapping
			var pdfMapping = controlFileData["pdfMapping"];
			var fieldTypes = controlFileData["fieldTypes"];

			for (var key in pdfMapping) {
				console.log('processing key',key)
				var value = pdfMapping[key];
				var pdfFillValue = '';
				var regex = new RegExp("{(.*?)}", 'ig');//"{BF_CITY}, {BF_STATE}, {BF_POSTAL}"
				var matchs = value.match(regex);
				if (matchs && matchs.length > 0) {
					pdfFillValue = value;
					_.each(matchs, function(matchValue){
						var fieldKey = matchValue.substring(1, matchValue.length-1);
						var fieldValue = fillData[fieldKey];
						pdfFillValue = pdfFillValue.replace(matchValue, fieldValue);
						if (pdfFillValue == '-') {
							pdfFillValue = '';
						}
					});
				} else {
					pdfFillValue = fillData[value];
				}
				var type = fieldTypes[key];
				if (type && type.toLowerCase() == 'checkbox') {
					pdfFillValue = 'On';
				}

				var regex = new RegExp("{(.*?)}", 'ig');//State Registration Sellers Permit or ID Number of Purchaser{STATE}
				var matchs = regex.exec(key);
				if (matchs && matchs.length > 1) {
					//console.log("key,matchs,matchValue,fieldKey=",key,matchs,matchValue,fieldKey)
					var matchValue = matchs[0];
					var fieldKey = matchs[1];
					var fieldValue = fillData[fieldKey];
					key = key.replace(matchValue, fieldValue);
				}

				if (pdfFillValue) {
					pdfFillData[key] = pdfFillValue;
				}
			}

			var pdfDefaultValue = controlFileData["pdfDefaultValue"] || {};
			for (var key in pdfDefaultValue) {
				var value = pdfDefaultValue[key];
				if (value == '{currentDate}') {
					value = formatDate(new Date());
					pdfDefaultValue[key] = value;
				}
			}
			fillData = _.extend(pdfDefaultValue, fillData)
			pdfFillData = _.extend(pdfDefaultValue, pdfFillData);


			var folderStructure = controlFileData["folderStructure"];
			_.find(folderStructure, function(field){
				var folderName = field;
				var regex = new RegExp("{(.*?)}", 'ig');
				var matchs = regex.exec(field);
				if (matchs && matchs.length > 1) {
					var key = matchs[1];
					folderName = fillData[key];
				}
				if (!folderName) {
					var errMessage = 'Folder Structure is invalid';
					var result = {
						type: 'error',
						status: 101,
						message: errMessage
					};
					throw result;
				}
				folderList.push(folderName);
			});

			var fileNameTemplate = controlFileData["fileName"];
			fileName = ''
			_.each(fileNameTemplate, function(field){
				fileName += fillData[field] + '-';
			});

			console.log("fileName=",fileName)
			var currentTime = new Date().getTime();
			fileName += currentTime + '.pdf';

			return pdfFillData;
		})
		.then(pdfFillData => {
			return fillForm(sourcePDF, destinationPDF, pdfFillData);
		})
		.then(() => {
			return getSignatureFieldPosition(destinationPDF)
			.then(result => {
				//console.log("getSignatureFieldPosition",result)
				fieldObj = result;
				return fieldObj;
			});
		})
		.then(() => {
			if (fieldObj) {//signature field existed
				fieldObj.text = formData["boxUserName"] || 'No Box Name Available';
				return generatePDFSignatureFile(fieldObj)
				.then(signaturePDF => {
					return addSignature(destinationPDF, signaturePDF)
					.then(result => {
						combinedPDF = result;
						return combinedPDF;
					});
				});
			} else {
				combinedPDF = destinationPDF;
				return combinedPDF;
			}
		})
		.then(() => {
			var result = createNewFolder(_parentFolderId, folderList);
			return result;
		})
		.then(parentId => {
			return uploadFile(parentId, fileName, combinedPDF);
		})
		.then(file => {
			var entry = _.first(file.entries);
			certificateFile = entry;

			var metadata = {};
			var metadataMapping = controlFileData["metadataMapping"];
			for (var key in metadataMapping) {
				var mappingValue = metadataMapping[key];
				metadata[key] = fillData[mappingValue];
			}
			console.log("addMetadata metadata: ", metadata);
			// for (var key in formData) {
			// 	var formDataFormatItem = formDataFormat[key] || {};
			// 	var type = formDataFormatItem.type;
			// 	if (type) {
			// 		if (formDataFormatItem.type == 'currentDate') {
			// 			formValue = formatDate(new Date());
			// 		}
			// 		formData[key] = formValue;
			// 	}
			// }
			metadata = _.extend(formData, metadata);
			return addMetadata(entry, templateKey, metadata);
		})
		.then(metadata => {
			console.log("metadata: ", metadata);
			var successDialog = controlFileData["successDialog"];
			return {
				statusCode: 200,
				body: JSON.stringify({
					type: 'success',
					data: certificateFile ,
					successDialog: successDialog
				})
			};
		})
		.catch(err => {
			console.log("catch err: ", err);
			var data = err.response ? err.response.body : err;
			//console.log("data: ", data);
			var message = data.message;
			return showError(message);
		});

	response.headers = headers;

	console.log("response: ", response);

	return response;
};

var parseCSVDataFromFiles = async function(data) {
	await Promise.all(data.map(async (item) => {
		var itemId = item.id;
		//var sourceCSV = DIR_NAME + item.name;
		var fileData = await getFileContent(itemId, item.name);
		item.fileData = csv.toArrays(fileData);
	}));
	return data;
}


const fillForm = function(sourcePDF, destinationPDF, data) {
	return new Promise(function(resolve, reject) {
		pdfFiller.fillFormWithOptions(sourcePDF, destinationPDF, data, false, DIR_NAME, function(err, result) {
			console.log("fillFormWithOptions err, result: ", err, result);
			if (err) reject(err);
			resolve(destinationPDF);
		});
	});
}

var getRequestParams = function(event) {
	let requestParams = {};
	if(event.body){
		try{
			console.log('parse body');
			requestParams = JSON.parse(event.body);
		}catch(ex){
			console.log('request body is not valid json');
			throw "invalid json string"
		}
	}
	// console.log('requestParams', requestParams);
	return requestParams;
}

var readStreamToFile = function(fileId, filePath) {
	console.log(`Reading stream from File: ${fileId}`);
	return new Promise(function(resolve, reject) {
		_boxClient.files.getReadStream(fileId)
		.then(stream => {
			console.log(`Box Streaming data for file ${fileId}`);
			var output = fs.createWriteStream(filePath);
			output.on('error', function (err) {
				console.log(err);
				reject(err);
			});
			stream.pipe(output);
			stream.on('end', () => {
				console.log('done reading');
				resolve(filePath);
			});
		})
		.catch(err => {
			reject(err);
		});
	});
}

var getFileContent = async function(fileId, fileName) {
	// return new Promise(function(resolve, reject) {
	// 	fileName = fileName || 'tempFile';
	// 	var tempFile = DIR_NAME + fileName;
	// 	readStreamToFile(fileId, tempFile)
	// 	.then(filePath => {
	// 		fs.readFile(filePath, 'utf8', function(err, fileData) {
	// 			if (err) {
	// 				reject(err);
	// 			}
	// 			resolve(fileData);
	// 		});
	// 	})
	// 	.catch(err => {
	// 		reject(err);
	// 	});
	// });

	return new Promise(function(resolve, reject) {
    	var decoder = new StringDecoder('utf8');
		_boxClient.files.getReadStream(fileId)
		.then(stream => {
			var dataStr = '';
			stream.on('data', function(data) {
				dataStr += data.toString();
			});
			stream.on('end', function() {
				var fileData = decoder.write(dataStr);
				resolve(fileData);
			});
		})
		.catch(err => {
			reject(err);
		});
	});
}

var uploadFile = function(parentId, fileName, combinedPDF) {
	console.log('uploadFile', parentId, fileName, combinedPDF);
	return new Promise(function(resolve, reject) {
		fs.readFile(combinedPDF, (err, buffer) =>{
			_boxClient.files.uploadFile(parentId, fileName, buffer)
			.then(file => {
				console.log('upload success');
				resolve(file);
			})
			.catch(err => {
				console.log('error: ', err);
				reject(err);
			});
		});
	});
}

var getSignatureFieldPosition = function(sourceFile) {
	return new Promise(function(resolve, reject) {
		console.log("sourceFile: ", sourceFile);
		const pdfParser = new PDFParser();
		pdfParser.on("pdfParser_dataError", errData => {
			console.error(errData.parserError);
			reject(errData);
		});
		pdfParser.on("pdfParser_dataReady", pdfData => {
			// console.log("JSON.stringify(pdfData): ", JSON.stringify(pdfData));
			var formImage = pdfData.formImage;
			var pageWidth = formImage.Width;
			var pages = formImage.Pages;
			var totalPage = pages.length;
			var pageHeight = pages[0].Height;

			var signatureField;
			var pageIndex = -1;
			_.find(pages, function(item, index){
				var currentField = _.find(item.Fields, {id: {Id: _signatureFieldId}});
				if (currentField) {
					signatureField = currentField;
					pageIndex = index;
					return;
				}
			});
			if (signatureField) {
				var ratio = 72;
				var A4PaperSize = {
					width: 8.5,
					height: 11
				}
				var posX = signatureField.x * ((A4PaperSize.width * ratio) / pageWidth)+5;
				var posY = signatureField.y * ((A4PaperSize.height * ratio) / pageHeight)-2;
				resolve({posX: posX, posY: posY, pageIndex: pageIndex, totalPage: totalPage});
			} else {
				//reject('signature field does not found');
				resolve(null)
			}
		});
		console.log("sourceFile: ", sourceFile);
		pdfParser.loadPDF(sourceFile);
	});
}
var addSignature = function(sourceFile, signaturePDF) {
	return new Promise(function(resolve, reject) {
		var output = DIR_NAME + 'combined.pdf';
		execFile( "pdftk", [sourceFile, "multistamp", signaturePDF, 'output', output], function (error, stdout, stderr) {
			if (error) {
				console.log('exec error: ' + error);
				reject(error);
			}
			resolve(output);
		});
	});
}

var generatePDFSignatureFile = function(fieldObj) {
	console.log('generatePDFSignatureFile', fieldObj);
	return new Promise(function(resolve, reject) {
		var text = fieldObj.text;
		var posX = fieldObj.posX;
		var posY = fieldObj.posY;
		var pageIndex = fieldObj.pageIndex;
		var totalPage = fieldObj.totalPage;

		//const doc = new PDFDocument;
		const doc = new PDFDocument({
			margin: 0
		});
		var signaturePDF = DIR_NAME + 'signature.pdf';
		let output = fs.createWriteStream(signaturePDF);
		var stream = doc.pipe(output);
		for (var i = 0; i < totalPage; i++) {
			if (i == pageIndex) {
				doc.font('fonts/HomemadeApple.ttf')
				.fontSize(15)
				.text(text, posX, posY);
			} else {
				doc.addPage();
			}
		}
		doc.end();
		stream.on('finish', function() {
			if (output) {
				resolve(output.path);
			} else {
				reject(output);
			}
		});
	});
}

// var fetchXMLFileContent = function(xmlFileId) {
// 	var xmlSourceFile = DIR_NAME + 'xmlSourceFile.xml';
// 	return new Promise(function(resolve, reject) {
// 		_boxClient.files.getReadStream(xmlFileId, null, (error, stream) => {
// 			if (error || !stream) {
// 				console.log('ReadStream error: ', error);
// 				reject(error);
// 			}
// 			console.log(`Box Streaming data for file ${xmlFileId}`);
// 			var output = fs.createWriteStream(xmlSourceFile);
// 			output.on('error', function (err) {
// 				console.log(err);
// 			});
// 			stream.pipe(output);
// 			stream.on('end', () => {
// 				fs.readFile(xmlSourceFile, 'utf8', function(err, xmlData) {
// 					var xmlData = xmlParser.xml2json(xmlData, {object: true});
// 					resolve(xmlData);
// 				});
// 			});
// 		});
// 	});
// }

var checkFileExist = function(fileId) {
	return _boxClient.files.get(fileId);
}

var checkItemValidation = function(item, formattedFormFields) {
	//console.log("item: ", item);
	var lookup = item.lookup;
	var fileData = item.fileData;
	var headers = _.first(fileData);
	fileData.shift();

	//remove special character
	var newHeaders = [];
	_.each(headers, function(header){
		header = header.replace(/[^A-Z0-9 \_\-\.]/gi, '')
		newHeaders.push(header);
	});
	headers = newHeaders;

	console.log("CSV File Headers: ", headers);
	console.log("Lookup Columns: ", lookup);
	console.log("Lookup Values: ", formattedFormFields);

	var failedItem = {
		count: 0
	};

	var row = _.find(fileData, function(rowData, index){
		var results = [];
		_.each(lookup, function(columnName){
			var colIndex = _.indexOf(headers, columnName);
			var colValue = formattedFormFields[columnName];
			results.push(rowData[colIndex] == colValue);
		});
		//console.log("results 1: ", results);
		var result = _.every(results, function(val) { return val === true; });
		//console.log("results 2: ", result);
		if (!result) {
			var count = _.filter(results, function(value){
			    return value === true;
			}).length;
			if (failedItem.count < count || count == 0) {
				failedItem.count = count;
				failedItem.rowData = rowData;
				failedItem.results = results;
			}
		}
		return result;
	});
	console.log("matching row: ", row);

	if (row) {
		var rowData = {};
		_.each(headers, function(header, index, list){
			rowData[header] = row[index];
		});
		return {success: true, rowData: rowData};
	}

	// console.log("lookup: ", lookup);
	// Find the lookup that failed - PH
	console.log("failed to find Item: ", failedItem);
	var failedFields = [];
	_.each(lookup, function(columnName, index){
		var results = failedItem.results;
		if (results && results[index] == false) {
			failedFields.push(columnName);
		}
	});
	// console.log("failedFields: ", failedFields);
	var errMessage = item.errMessage.replace(/\{0\}/g, failedFields.join(', '));
	return {success: false, errMessage: errMessage};
}

var removeJSONComment = function (obj) {
  for(var prop in obj) {
    if (prop === '__comment')
      delete obj[prop];
    else if (typeof obj[prop] === 'object')
      removeJSONComment(obj[prop]);
  }
}

var addMetadata = function(file, templateKey, formData) {
	var fileId = file.id;
	var scope = _boxClient.metadata.scopes.ENTERPRISE;
	var metadata = {};
	return _boxClient.metadata.getTemplateSchema(scope, templateKey)
		.then(template => {
			//console.log("getTemplateSchema template: ", template);
			var fields = template.fields;
			_.each(fields, function(field){
				var key = field.key;
				var value = formData[key];
				var type = field.type;
				if (value) {
					if (type == 'date') {
						value = new Date(value).toISOString();//timezone issue
					} else if (type == 'number' || type == 'integer') {
						value = parseInt(value);
					} else if (type == 'float') {
						value = parseFloat(value);
					}
				}
				if (value) {
					metadata[key] = value;
				}
			});
			return _boxClient.files.addMetadata(fileId, scope, templateKey, metadata);
		});
}

// var createNewFolder = function(parentId, list) {
// 	if (list.length == 0) {
// 		return parentId;
// 	}
// 	var promise = Promise.resolve().then(() => {
// 		var folderName = list.shift();
// 		_boxClient.folders.create(parentId, folderName)
// 		.then(folder => {
// 			console.log("folder: ", folder);
// 			var folderId = folder.id;
// 			console.log("folderId: ", folderId);
// 			return createNewFolder(folderId, list);
// 		})
// 		.catch(err => {
// 			var data = err.response.body;
// 			if (data.status == 409) {
// 				var item = data.context_info.conflicts[0];
// 				console.log("item: ", item);
// 				var folderId = item.id;
// 				console.log("folderId: ", folderId);
// 				return createNewFolder(folderId, list);
// 			}
// 		});
// 	});
// 	return (promise);
// }

var createNewFolder = (parentId, list) => new Promise((resolve, reject) => {
	console.log('createNewFolder');
	if (list.length > 0) {
		var folderName = list.shift();
		_boxClient.folders.create(parentId, folderName)
			.then(folder => {
				var folderId = folder.id;
				resolve(createNewFolder(folderId, list));
			})
			.catch(err => {
				var data = err.response.body;
				if (data.status == 409) {
					var item = data.context_info.conflicts[0];
					var folderId = item.id;
					resolve(createNewFolder(folderId, list));
				} else {
					reject(err);
				}
			});
	} else {
		resolve(parentId);
	}
});

var formatDate = function(date) {
  return date.getMonth()+1 + "/" + date.getDate() + "/" + date.getFullYear();
}

var showError = function(message) {
	var result = {
		statusCode: 200,
		body: JSON.stringify({
			type: 'error',
			message: message
		}),
		headers: headers
	}
	return result;
}

// module.exports.fetchXMLFileContent = async (event, context) => {
// 	console.log('fetchXMLFileContent');
// 	var xmlFileId = process.env.XMLFILE_BOXID;
// 	var response = await fetchXMLFileContent(xmlFileId)
// 	.then(xmlData => {
// 		console.log('xmlData: ', xmlData);
// 		if (!xmlData) return;
// 		var formData = xmlData.INDATA && xmlData.INDATA.INVOICE;

// 		var convMap = {
// 			"businessUnit": "Address",
// 			"state": "Vendor_Address",
// 			"certificateType": "Buyer_Name",
// 			"vendorId": "Vendor_Name",
// 			"poNumber": "Buyer_Address_2",
// 			"poLineNumber": "Buyer_Address_3",
// 			"reasonForExemption": "Description_Property_Service_1",
// 			"signersName": "Signers_Signature"
// 		};

// 		var fieldJson = [];
// 		var keys = _.keys(formData);
// 		_.each(keys, function(key){
// 			fieldJson.push({
// 				title: key,
// 				fieldValue: JSON.stringify(formData[key])
// 			})
// 		});

// 		console.log("fieldJson: ", fieldJson);

// 		var mappedFields = pdfFiller.mapForm2PDF(fieldJson, convMap);

// 		var signatureText = mappedFields[_signatureFieldId] || 'Geoff H.';
// 		delete mappedFields[_signatureFieldId];

// 		var fillData = mappedFields;

// 		console.log("fillData: ", fillData);
// 		return {
// 			statusCode: 200,
// 			body: JSON.stringify('result'),
// 		};
// 	});

// 	console.log("response: ", response);
// 	return response;
// }
