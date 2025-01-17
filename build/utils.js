'use strict';

const path = require('path'),
	async = require('async'),
	fs = require('fs-extra'),
	glob = require('glob'),
	appc = require('node-appc'),
	request = require('request'),
	os = require('os'),
	ssri = require('ssri'),
	tempDir = os.tmpdir(),
	util = require('util'),
	Utils = {};

function leftpad(str, len, ch) {
	str = String(str);
	let i = -1;
	if (!ch && ch !== 0) {
		ch = ' ';
	}
	len -= str.length;
	while (++i < len) {
		str = ch + str;
	}
	return str;
}

Utils.timestamp = function () {
	const date = new Date();
	return '' + (date.getUTCMonth() + 1) + '/' + date.getUTCDate() + '/' + (date.getUTCFullYear()) + ' ' + leftpad(date.getUTCHours(), 2, '0') + ':' + leftpad(date.getUTCMinutes(), 2, '0');
};

Utils.copyFile = function (srcFolder, destFolder, filename, next) {
	fs.copy(path.join(srcFolder, filename), path.join(destFolder, filename), next);
};

Utils.copyFiles = function (srcFolder, destFolder, files, next) {
	async.each(files, function (file, cb) {
		Utils.copyFile(srcFolder, destFolder, file, cb);
	}, next);
};

Utils.globCopy = function (pattern, srcFolder, destFolder, next) {
	glob(pattern, { cwd: srcFolder }, function (err, files) {
		if (err) {
			return next(err);
		}
		Utils.copyFiles(srcFolder, destFolder, files, next);
	});
};

Utils.globCopyFlat = function (pattern, srcFolder, destFolder, next) {
	glob(pattern, { cwd: srcFolder }, function (err, files) {
		if (err) {
			console.error(err);
			return next(err);
		}

		async.each(files, function (filename, cb) {
			const filenameWithoutDirectory = filename.split('/')[1]; // TODO: Refactor to simply copy without it's source directory
			fs.copy(path.join(srcFolder, filename), path.join(destFolder, filenameWithoutDirectory), cb);
		}, next);
	});
};

Utils.copyAndModifyFile = function (srcFolder, destFolder, filename, substitutions, next) {
	// FIXME If this is a directory, we need to recurse into directory!

	// read in src file, modify contents, write to dest folder
	fs.readFile(path.join(srcFolder, filename), function (err, data) {
		if (err) {
			return next(err);
		}
		// Go through each substitution and replace!
		let str = data.toString();
		for (const key in substitutions) {
			if (substitutions.hasOwnProperty(key)) {
				str = str.split(key).join(substitutions[key]);
			}
		}
		fs.writeFile(path.join(destFolder, filename), str, next);
	});
};

Utils.copyAndModifyFiles = function (srcFolder, destFolder, files, substitutions, next) {
	async.each(files, function (file, cb) {
		Utils.copyAndModifyFile(srcFolder, destFolder, file, substitutions, cb);
	}, next);
};

function download(url, destination, callback) {
	console.log('Downloading %s', url);

	const tempStream = fs.createWriteStream(destination);
	const req = request({ url: url });

	req.pipe(tempStream);

	req.on('error', function (err) {
		fs.existsSync(destination) && fs.unlinkSync(destination);
		console.log();
		console.error('Failed to download: %s', err.toString());
		callback(err);
	});

	req.on('response', function (req) {
		if (req.statusCode >= 400) {
			// something went wrong, abort
			console.log();
			const err = util.format('Request for %s failed with HTTP status code %s %s', url, req.statusCode, req.statusMessage);
			console.error(new Error(err));
			return callback(err);
		} else if (req.headers['content-length']) {
			// we know how big the file is, display the progress bar
			const total = parseInt(req.headers['content-length']),
				bar = new appc.progress('  :paddedPercent [:bar] :etas', {
					complete: '='.cyan,
					incomplete: '.'.grey,
					width: 40,
					total: total
				});

			req.on('data', function (buffer) {
				bar.tick(buffer.length);
			});

			tempStream.on('close', function () {
				if (bar) {
					bar.tick(total);
					console.log('\n');
				}
				callback(null, destination);
			});
		} else {
			// we don't know how big the file is, display a spinner
			const busy = new appc.busyindicator();
			busy.start();

			tempStream.on('close', function () {
				busy && busy.stop();
				console.log();
				callback(null, destination);
			});
		}
	});
}

function downloadWithIntegrity(url, downloadPath, integrity, callback) {
	download(url, downloadPath, function (err, file) {
		if (err) {
			return callback(err);
		}
		// Verify integrity!
		ssri.checkStream(fs.createReadStream(file), integrity).then(() => {
			callback(null, file);
		}).catch(e => {
			callback(e);
		});
	});
}

function cachedDownloadPath(url) {
	// Use some consistent name so we can cache files!
	const cacheDir = path.join(process.env.SDK_BUILD_CACHE_DIR || tempDir, 'timob-build');
	fs.existsSync(cacheDir) || fs.mkdirsSync(cacheDir);

	const filename = url.slice(url.lastIndexOf('/') + 1);
	// Place to download file
	return path.join(cacheDir, filename);
}

Utils.generateSSRIHashFromURL = function (url, callback) {
	if (url.startsWith('file://')) {
		// Generate integrity hash!
		ssri.fromStream(fs.createReadStream(url.slice(7))).then(integrity => {
			callback(null, integrity.toString());
		}).catch(e => {
			callback(e);
		});
		return;
	}
	const downloadPath = cachedDownloadPath(url);
	fs.removeSync(downloadPath);
	download(url, downloadPath, function (err, file) {
		if (err) {
			return callback(err);
		}
		// Generate integrity hash!
		ssri.fromStream(fs.createReadStream(file)).then(integrity => {
			callback(null, integrity.toString());
		}).catch(e => {
			callback(e);
		});
	});
};

Utils.downloadURL = function downloadURL(url, integrity, callback) {
	if (url.startsWith('file://')) {
		if (!fs.existsSync(url.slice(7))) {
			return callback(new Error('File URL does not exist on disk: %s', url));
		}
		// if it passes integrity check, we're all good, return path to file
		ssri.checkStream(fs.createReadStream(url.slice(7)), integrity).then(() => {
			// cached copy is still valid, integrity hash matches
			callback(null, url.slice(7));
		}).catch(e => callback(e));
		return;
	}

	if (!integrity) {
		return callback(new Error('No "integrity" value given for %s, may need to run "node scons.js modules-integrity" to generate new module listing with updated integrity hashes.', url));
	}

	const downloadPath = cachedDownloadPath(url);
	// Check if file already exists and passes integrity check!
	if (fs.existsSync(downloadPath)) {
		// if it passes integrity check, we're all good, return path to file
		ssri.checkStream(fs.createReadStream(downloadPath), integrity).then(() => {
			// cached copy is still valid, integrity hash matches
			callback(null, downloadPath);
		}).catch(() => {
			// hash doesn't match. Wipe the cached version and re-download
			fs.removeSync(downloadPath);
			downloadWithIntegrity(url, downloadPath, integrity, callback);
		});
	} else {
		// download and verify integrity
		downloadWithIntegrity(url, downloadPath, integrity, callback);
	}
};

/**
 * @returns {string} absolute path to SDK install root
 */
Utils.sdkInstallDir = function () {
	switch (os.platform()) {
		case 'win32':
			return path.join(process.env.ProgramData, 'Titanium');

		case 'darwin':
			return path.join(process.env.HOME, 'Library', 'Application Support', 'Titanium');

		case 'linux':
		default:
			return path.join(process.env.HOME, '.titanium');
	}
};

/**
 * @param  {String}   versionTag [description]
 * @param  {boolean}   [symlinkIfPossible=false] [description]
 * @returns {Promise<void>}
 */
Utils.installSDK = async function (versionTag, symlinkIfPossible = false) {
	const dest = Utils.sdkInstallDir();

	let osName = os.platform();
	if (osName === 'darwin') {
		osName = 'osx';
	}

	const destDir = path.join(dest, 'mobilesdk', osName, versionTag);
	try {
		const destStats = fs.lstatSync(destDir);
		if (destStats.isDirectory()) {
			console.log('Destination exists, deleting %s...', destDir);
			await fs.remove(destDir);
		} else if (destStats.isSymbolicLink()) {
			console.log('Destination exists as symlink, unlinking %s...', destDir);
			fs.unlinkSync(destDir);
		}
	} catch (error) {
		// Do nothing
	}

	const zipDir = path.join(__dirname, '..', 'dist', `mobilesdk-${versionTag}-${osName}`);
	const dirExists = await fs.pathExists(zipDir);

	if (dirExists) {
		console.log('Installing %s...', zipDir);
		if (symlinkIfPossible) {
			console.log('Symlinking built SDK to install!');
			// FIXME: What about modules? Can we symlink those in?
			return fs.ensureSymlink(path.join(zipDir, 'mobilesdk', osName, versionTag), destDir);
		}
		await fs.copy(path.join(zipDir, 'mobilesdk'), path.join(dest, 'mobilesdk'), { dereference: true });
		return fs.copy(path.join(zipDir, 'modules'), path.join(dest, 'modules'));
	}

	// try the zip
	const zipfile = path.join(__dirname, '..', 'dist', `mobilesdk-${versionTag}-${osName}.zip`);
	console.log('Installing %s...', zipfile);
	return new Promise((resolve, reject) => {
		appc.zip.unzip(zipfile, dest, {}, function (err) {
			if (err) {
				return reject(err);
			}
			return resolve();
		});
	});
};

/**
* Given an npm module id, this will copy it and it's dependencies to a
* destination "node_modules" folder.
* Note that all of the packages are copied to the top-level of "node_modules",
* not nested!
* Also, to shortcut the logic, if the original package has been copied to the
* destination we will *not* attempt to read it's dependencies and ensure those
* are copied as well! So if the modules version changes or something goes
* haywire and the copies aren't full finished due to a failure, the only way to
* get right is to clean the destination "node_modules" dir before rebuilding.
*
* @param  {String} moduleId           The npm package/module to copy (along with it's dependencies)
* @param  {String} destNodeModulesDir path to the destination "node_modules" folder
* @param  {Array}  [paths=[]]         Array of additional paths to pass to require.resolve() (in addition to those from require.resolve.paths(moduleId))
*/
function copyPackageAndDependencies(moduleId, destNodeModulesDir, paths = []) {
	const destPackage = path.join(destNodeModulesDir, moduleId);
	if (fs.existsSync(path.join(destPackage, 'package.json'))) {
		return; // if the module seems to exist in the destination, just skip it.
	}

	// copy the dependency's folder over
	let pkgJSONPath;
	if (require.resolve.paths) {
		const thePaths = require.resolve.paths(moduleId);
		pkgJSONPath = require.resolve(path.join(moduleId, 'package.json'), { paths: thePaths.concat(paths) });
	} else {
		pkgJSONPath = require.resolve(path.join(moduleId, 'package.json'));
	}
	const srcPackage = path.dirname(pkgJSONPath);
	const srcPackageNodeModulesDir = path.join(srcPackage, 'node_modules');
	for (let i = 0; i < 3; i++) {
		fs.copySync(srcPackage, destPackage, {
			preserveTimestamps: true,
			filter: src => !src.startsWith(srcPackageNodeModulesDir)
		});

		// Quickly verify package copied, I've experienced occurences where it does not.
		// Retry up to three times if it did not copy correctly.
		if (fs.existsSync(path.join(destPackage, 'package.json'))) {
			break;
		}
	}

	// Now read it's dependencies and recurse on them
	const packageJSON = fs.readJSONSync(pkgJSONPath);
	for (const dependency in packageJSON.dependencies) {
		copyPackageAndDependencies(dependency, destNodeModulesDir, [ srcPackageNodeModulesDir ]);
	}
}
Utils.copyPackageAndDependencies = copyPackageAndDependencies;

module.exports = Utils;
