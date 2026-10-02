'use strict';
module.exports = {
  ...require('./service'),
  ...require('./prompt'),
  ffmpeg: require('./ffmpeg'),
};
