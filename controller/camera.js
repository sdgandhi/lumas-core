const EventEmitter = require("events").EventEmitter;
const request = require('request');
const http = require('http');
const util = require('util')
const memfs = require('memfs');
const fs = require('fs');
const logger = require('./logger.js');
const retry = require('retry');
const cv = require('/node_modules/opencv4nodejs/lib/opencv4nodejs');

var snapshot;

const camera_options = {
  auth: {
    user: process.env.CAMERA_USER,
    pass: process.env.CAMERA_PASS,
    sendImmediately: false
  },
  forever: true
};

module.exports = Camera;

function Camera(controllerEvents = undefined) {
  const self = this;
  if (controllerEvents) {
    controllerEvents.on('classifiedImg', function(imgBuf) {
      memfs.writeFile('/annotatedSnapshot.jpg', imgBuf, function() {});
      fs.writeFile('/app/test.jpg', imgBuf, function() {});
    });
  }

  setInterval(function () {
    self.captureCameraSnapshot(self)
  }, 10000);

  self.cameraMotionMonitor();
  EventEmitter.call(self);
}

util.inherits(Camera, EventEmitter)

Camera.prototype.captureCameraSnapshot = function (self) {
  var file = memfs.createWriteStream('/cameraSnapshot.jpg');

  request
    .get(process.env.CAMERA_SNAPSHOT_URL, {
      auth: {
        user: process.env.CAMERA_USER,
        pass: process.env.CAMERA_PASS,
        sendImmediately: false
      }
    })
    .on('response', function(response) {
      if (response.statusCode == 401) {
        logger.log('error', "Unauthorized to access camera snapshot API");
      }
    })
    .on('error', function(err) {
      logger.log('error', "Error message: " + err);
    })
    .on('end', function() {
      memfs.readFile('/cameraSnapshot.jpg', (err, data) => {
        if (!err) {
          self.emit('image', data)
        }
      });

      if (process.env.CAMERA_SAVE_SNAPSHOTS === "true") {
        var fsfile = fs.createWriteStream("/snapshots/" + Date.now() + ".jpg");
        memfs.createReadStream('/cameraSnapshot.jpg').pipe(fsfile);
      }
      logger.log('debug', "Succesfully updated camera snapshot");
    })
    .pipe(file);

}

Camera.prototype.processFeed = function () {
  const self = this;
  let cap;

  var cameraOperation = retry.operation({ maxTimeout: 60 * 1000});

  cameraOperation.attempt( function() {
    cap = new cv.VideoCapture(process.env.CAMERA_STREAM_URL);
  });

  const interval = setInterval(() => {
    let frame = cap.read();

    if (frame && !frame.empty) {
      self.emit('frame', frame);

      // Classification expects an encoded image
      var jpg = null;
      try {
        jpg = cv.imencode('.jpg', frame);
        self.emit('image', jpg);
      } catch(error) { logger.log('error', error) }

    }
  }, 0);

  //Stop processing after 60 seconds
  setTimeout(function() {
    clearInterval(interval)
  }, 60000);
}

Camera.prototype.amcrestMotionMonitor = function () {
  const self = this;

  logger.log('info', "Listening for motion from camera");

  // Connect to the camera and monitor for motion
  self.motionRequest = request.get(process.env.CAMERA_MOTION_URL, camera_options)
  self.motionRequest.on('abort', function() {
      logger.log('error', "Connection to Camera aborted");
      cameraMotionMonitor();
    })
    .on('error', function(err) {
      logger.log('error', "Got error: " + err + ". Resetting camera connection");
      self.amcrestMotionMonitor();
    })
    .on('timeout', function() {
      logger.log('error', "Connection to camera timed out. Reconnecting");
      self.amcrestMotionMonitor();
    })
    .on('upgrade', function() {
      logger.log('error', "Connection to camera got an upgrade connection request. Reconnecting");
      self.amcrestMotionMonitor();
    })
    .on('close', function() {
      logger.log('info', "Connection to Camera closed");
      self.amcrestMotionMonitor();
    })
    .on('response', function(res) {
      code = null;
      action = null;
      index = null;
  
  
      res.on('data', function (body) {
        data = body.toString('utf8');
  
        if (data.substring(0,2) == '--') {
          logger.log('debug', 'Receeived response from camera: ' + data);
          lines = data.split('\r\n')
  
          codeString = lines[3].split(';')[0]
          actionString = lines[3].split(';')[1]
          indexString = lines[3].split(';')[2]
  
          code = codeString.split('=')[1]
          action = actionString.split('=')[1]
          index = indexString.split('=')[1]
  
          if (action == 'Start') {
            self.processFeed();
          }
        }
      })
    })

  // Initiate a new connection every 10 seconds since the connection
  // gets stale and stops responding without any error for some reason.
  setTimeout(function() {
    self.motionRequest.agent.destroy();
    self.amcrestMotionMonitor();
  }, 600000);
}

Camera.prototype.cameraMotionMonitor = function () {
  const self = this;

  http.createServer(function(request, response) {
    self.processFeed();
  }).listen(9999);

  self.amcrestMotionMonitor();
}

Camera.prototype.getSnapshot = function(callback) {
  var age;
  var file;

  memfs.stat('/annotatedSnapshot.jpg', function(err, stats) {
    if (stats) {
      age = Date.now() - stats.mtimeMs;
      logger.log("debug", "Annotated snapshot is " + age + "ms old");

      //Only send the annotated snapshot if it's less than 10 seconds old
      if (age < 10000) {
        logger.log("debug", "Serving annotated camera snapshot");
        file = '/annotatedSnapshot.jpg';
      } else {
        logger.log("debug", "Serving cached camera snapshot");
        file = '/cameraSnapshot.jpg';
      }
    } else {
      logger.log("debug", "Serving cached camera snapshot");
      file = '/cameraSnapshot.jpg';
    }

    memfs.readFile(file, function(err, buf) {
      if (err) {
        logger.log("error", "Could not read " + file + " from memfs: " + err.message);
      }

      callback(buf);
    });
  });
}
