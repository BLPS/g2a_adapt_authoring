// external
const archiver = require('archiver');
const async = require('async');
const exec = require('child_process').exec;
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const semver = require('semver');
const shortid = require('shortid');
// internal
const configuration = require('../../../lib/configuration');
const Constants = require('../../../lib/outputmanager').Constants;
const helpers = require('../../../lib/helpers');
const installHelpers = require('../../../lib/installHelpers');
const logger = require('../../../lib/logger');
const origin = require('../../../');
const outputHelpers = require('./outputHelpers');
const usermanager = require('../../../lib/usermanager');

function publishCourse(courseId, mode, request, response, next) {
  let app = origin();
  let self = this;
  let user = usermanager.getCurrentUser();
  let tenantId = user.tenant._id;
  let outputJson = {};
  let isRebuildRequired = false;
  let themeName;
  let menuName;
  let frameworkVersion;
  let isForceRebuild;

  let resultObject = {};

  // shorthand directories
  const FRAMEWORK_ROOT_FOLDER = path.join(configuration.tempDir, configuration.getConfig('masterTenantID'), Constants.Folders.Framework);
  const SRC_FOLDER = path.join(FRAMEWORK_ROOT_FOLDER, Constants.Folders.Source);
  const COURSES_FOLDER = path.join(FRAMEWORK_ROOT_FOLDER, Constants.Folders.AllCourses);
  const COURSE_FOLDER = path.join(COURSES_FOLDER, tenantId, courseId);
  const BUILD_FOLDER = path.join(COURSE_FOLDER, Constants.Folders.Build);
  const CDN_FOLDER = path.join(configuration.getConfig('courseCdnPath'), courseId);
  const CDN_RELEASE_FILE = path.join(CDN_FOLDER, 'release.json');
  const CDN_RELEASE_ID = shortid().toLowerCase();
  const CDN_RELEASE_FOLDER = path.join(CDN_FOLDER, CDN_RELEASE_ID);
  const CDN_DOMAIN = configuration.getConfig('courseCdnDomain');
  const CDN_RELEASES_NUM = 0;
  const SRC_DIR = path.resolve(__dirname, 'src');

  let releaseInfo = { current: null, releases: [], index: 0 };

  let customPluginName = user._id;

  const getGruntFatalError = stdout => {
    const indexStart = stdout.indexOf('\nFatal error: ');

    if (indexStart === -1) return;

    const indexEnd = stdout.indexOf('\n\nExecution Time');

    return stdout.substring(indexStart, indexEnd !== -1 ? indexEnd : stdout.length);
  }

  async.waterfall([
    // get an object with all the course data
    function(callback) {
      self.getCourseJSON(tenantId, courseId, function(err, data) {
        if (err) {
          return callback(err);
        }
        // Store off the retrieved collections
        outputJson = data;
        outputJson.block = outputHelpers.removeEmptyBlocks(outputJson.block, outputJson.component);
        callback(null);
      });
    },
    // validate the course data
    function(callback) {
      outputHelpers.validateCourse(outputJson, function(error, isValid) {
        if (error || !isValid) {
          return callback({ message: error });
        }

        callback(null);
      });
    },
    //
    function(callback) {
      var temporaryThemeFolder = path.join(SRC_FOLDER, Constants.Folders.Theme, customPluginName);
      self.applyTheme(tenantId, courseId, outputJson, temporaryThemeFolder, function(err, appliedThemeName) {
        if (err) {
          return callback(err);
        }

        self.writeCustomStyle(tenantId, courseId, temporaryThemeFolder, function(err) {
          if (err) {
            return callback(err);
          }
          // Replace the theme in outputJson with the applied theme name.
          themeName = appliedThemeName;
          outputJson['config'][0]._theme = themeName;
          callback(null);
        });
      });
    },
    function(callback) {
      self.sanitizeCourseJSON(mode, outputJson, function(err, data) {
        if (err) {
          return callback(err);
        }
        // Update the JSON object
        outputJson = data;
        callback(null);
      });
    },
    function(callback) {
      self.buildFlagExists(path.join(BUILD_FOLDER, Constants.Filenames.Rebuild), function(err, buildFlagExists) {
        if (err) {
          return callback(err);
        }
        isForceRebuild = request && request.query.force === 'true';

        if (!fsExtra.existsSync(path.normalize(BUILD_FOLDER + '/index.html'))) {
          buildFlagExists = true;
        }

        if (mode === Constants.Modes.Export || mode === Constants.Modes.Publish || buildFlagExists || isForceRebuild) {
          isRebuildRequired = true;
        }
        callback(null);
      });
    },
    function(callback) {
      if (mode === Constants.Modes.Export || mode === Constants.Modes.Publish || isForceRebuild) {
        fsExtra.emptyDirSync(BUILD_FOLDER);
      }
      callback(null);
    },
    function(callback) {
      var temporaryMenuFolder = path.join(SRC_FOLDER, Constants.Folders.Menu, customPluginName);
      self.applyMenu(tenantId, courseId, outputJson, temporaryMenuFolder, function(err, appliedMenuName) {
        if (err) {
          return callback(err);
        }
        menuName = appliedMenuName;
        callback(null);
      });
    },
    function(callback) {
      var assetsJsonFolder = path.join(BUILD_FOLDER, Constants.Folders.Course, outputJson['config']._defaultLanguage);
      var assetsFolder = path.join(assetsJsonFolder, Constants.Folders.Assets);

      self.writeCourseAssets(tenantId, courseId, assetsJsonFolder, assetsFolder, outputJson, function(err, modifiedJson) {
        if (err) {
          return callback(err);
        }
        // Store the JSON with the new paths to assets
        outputJson = modifiedJson;
        callback(null);
      });
    },
    function(callback) {
      self.writeCourseJSON(outputJson, path.join(BUILD_FOLDER, Constants.Folders.Course), function(err) {
        if (err) {
          return callback(err);
        }
        callback(null);
      });
    },
    function(callback) {
      installHelpers.getInstalledFrameworkVersion(function(error, version) {
        frameworkVersion = version;
        callback(error);
      });
    },
    function(callback) {
      if (!isRebuildRequired) {
        return callback();
      }
      logger.log('info', 'Attempting to update browserslist');
      exec('npx browserslist --update-db', { cwd: FRAMEWORK_ROOT_FOLDER }, e => callback(e));
    },
    function(callback) {
      if (!isRebuildRequired) {
        resultObject.success = true;
        return callback(null, 'Framework already built, nothing to do');
      }

      logger.log('info', '3.1. Ensuring framework build exists');

      var args = [];
      var outputFolder = COURSE_FOLDER.replace(FRAMEWORK_ROOT_FOLDER + path.sep,'');

      // Append the 'build' folder to later versions of the framework
      if (semver.gte(semver.clean(frameworkVersion), semver.clean('2.0.0'))) {
        outputFolder = path.join(outputFolder, Constants.Folders.Build);
      }

      args.push('--outputdir=' + outputFolder);
      args.push('--theme=' + themeName);
      args.push('--menu=' + menuName);

      logger.log('info', '3.2. Using theme: ' + themeName);
      logger.log('info', '3.3. Using menu: ' + menuName);

      var generateSourcemap = outputJson.config._generateSourcemap;
      var buildMode = generateSourcemap === true ? 'dev' : 'prod';

      logger.log('info', 'npx grunt server-build:' + buildMode + ' ' + args.join(' '));

      child = exec('npx grunt server-build:' + buildMode + ' ' + args.join(' '), {cwd: path.join(FRAMEWORK_ROOT_FOLDER)}, function(error, stdout, stderr) {
        if (error !== null) {
          logger.log('error', 'exec error: ' + error);
          logger.log('error', 'stdout error: ' + stdout);
          error.message += getGruntFatalError(stdout) || '';
          resultObject.success = true;
          return callback(error, 'Error building framework');
        }

        if (stdout.length != 0) {
          logger.log('info', 'stdout: ' + stdout);
          resultObject.success = true;

          // Indicate that the course has built successfully
          app.emit('previewCreated', tenantId, courseId, outputFolder);

          return callback(null, 'Framework built OK');
        }

        if (stderr.length != 0) {
          logger.log('error', 'stderr: ' + stderr);
          resultObject.success = false;
          return callback(stderr, 'Error (stderr) building framework!');
        }

        resultObject.success = true;
        return callback(null, 'Framework built');
      });
    },
    function(err, callback) {
      self.clearBuildFlag(path.join(BUILD_FOLDER, Constants.Filenames.Rebuild), function(err) {
        callback(null);
      });
    },
    function(callback) {
      const configPath = path.join(BUILD_FOLDER, Constants.Folders.Course, Constants.CourseCollections.config.filename);
      self.removeBuildIncludes(configPath, err => callback(err));
    },
    function(callback) {
      if (!fsExtra.existsSync(CDN_FOLDER)){
        fsExtra.mkdirSync(CDN_FOLDER);
        fsExtra.copySync(SRC_DIR, CDN_FOLDER);
      }
      if (!fsExtra.existsSync(CDN_RELEASE_FOLDER)){
        fsExtra.mkdirSync(CDN_RELEASE_FOLDER);
      }
      callback(null);
    },
    function(callback) {
      fsExtra.copySync(BUILD_FOLDER, CDN_RELEASE_FOLDER);
      callback(null);
    },
    function(callback) {
      if (fsExtra.existsSync(CDN_RELEASE_FILE)){
        releaseInfo = fsExtra.readJsonSync(CDN_RELEASE_FILE, { throws: false })
      }
      callback(null);
    },
    function(callback) {
      releaseInfo.index = releaseInfo.index + 1;
      const currentReleaseInfo = {
        index: releaseInfo.index,
        id: CDN_RELEASE_ID,
        course: courseId,
        date: new Date().toUTCString(),
        url: new URL(courseId + '/' + CDN_RELEASE_ID, CDN_DOMAIN).href,
        zip: new URL(courseId + '/' + CDN_RELEASE_ID + '.zip', CDN_DOMAIN).href
      }

      releaseInfo.current = currentReleaseInfo;
      if (CDN_RELEASES_NUM > 0) {
        releaseInfo.releases.push(currentReleaseInfo);
        let rTarget = releaseInfo.index - CDN_RELEASES_NUM;
        releaseInfo.releases = releaseInfo.releases.filter((release) => release.index > rTarget);
      } else if (typeof releaseInfo.releases !== 'undefined') {
        delete releaseInfo.releases;
      }

      fsExtra.writeJsonSync(CDN_RELEASE_FILE, releaseInfo);
      callback(null);
    },
    function (callback) {
      const excludeList = ['release.json', 'index.html'];

      if(typeof releaseInfo.releases !== 'undefined') {
        for (const release of releaseInfo.releases) {
          excludeList.push(release.id);
          excludeList.push(release.id + '.zip');
        }
      } else {
        excludeList.push(releaseInfo.current.id);
        excludeList.push(releaseInfo.current.id + '.zip');
      }
      fs.readdir(CDN_FOLDER, (err, files) => {
        if (err) {
          logger.log('error', err.message);
          return callback(err.message, 'Error reading directories');
        }
        for (const file of files) {
          if (!excludeList.includes(file)) {
            fsExtra.removeSync(path.join(CDN_FOLDER, file));
          }
        }
        return callback(null);
      });
    },
    function(callback) {
      // Now zip the build package
      const filename = path.join(CDN_FOLDER, releaseInfo.current.id + '.zip');
      const output = fs.createWriteStream(filename);
      const archive = archiver('zip');

      output.on('close', function() {
        // Indicate that the zip file is ready for download
        // app.emit('zipCreated', tenantId, courseId, filename, zipName);
        callback();
      });
      archive.on('error', function(err) {
        logger.log('error', err);
        callback(err);
      });
      archive.pipe(output);
      archive.glob('**/*', { cwd: path.join(BUILD_FOLDER) });
      archive.finalize();
    },
    function(callback) {
      resultObject.url = new URL(courseId, CDN_DOMAIN).href
      resultObject.info = releaseInfo.current
      return callback();
    }
  ], function(err) {
    if (err) {
      logger.log('error', err);
      return next(err);
    }
    next(null, resultObject);
  });
}

module.exports = publishCourse;
