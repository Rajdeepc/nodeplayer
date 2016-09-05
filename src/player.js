'use strict';
const _ = require('lodash');
const async = require('async');
const util = require('util');
const labeledLogger = require('./logger');
import Queue from './queue';
const modules = require('./modules');

export default class Player {
  constructor(options) {
    options = options || {};

    // TODO: some of these should NOT be loaded from config
    _.bindAll.apply(_, [this].concat(_.functions(this)));
    this.config = options.config || require('./config').getConfig();
    this.logger = options.logger || labeledLogger('core');
    this.queue = options.queue || new Queue(this);
    this.nowPlaying = options.nowPlaying || null;
    this.play = options.play || false;
    this.repeat = options.repeat || false;
    this.plugins = options.plugins || {};
    this.backends = options.backends || {};
    this.prepareTimeouts = options.prepareTimeouts || {};
    this.volume = options.volume || 1;
    this.songEndTimeout = options.songEndTimeout || null;
    this.pluginVars = options.pluginVars || {};

    this.init = this.init.bind(this);
  }

  /**
   * Initializes player
   */
  init() {
    const player = this;
    const config = player.config;
    const forceUpdate = false;

    // initialize plugins & backends
    async.series([
      callback => {
        modules.loadBuiltinPlugins(player, plugins => {
          player.plugins = plugins;
          player.callHooks('onBuiltinPluginsInitialized');
          callback();
        });
      }, callback => {
        modules.loadPlugins(player, config.plugins, forceUpdate, results => {
          player.plugins = _.extend(player.plugins, results);
          player.callHooks('onPluginsInitialized');
          callback();
        });
      }, callback => {
        modules.loadBuiltinBackends(player, backends => {
          player.backends = backends;
          player.callHooks('onBuiltinBackendsInitialized');
          callback();
        });
      }, callback => {
        modules.loadBackends(player, config.backends, forceUpdate, results => {
          player.backends = _.extend(player.backends, results);
          player.callHooks('onBackendsInitialized');
          callback();
        });
      },
    ], () => {
      player.logger.info('ready');
      player.callHooks('onReady');
    });
  }

  // call hook function in all modules
  // if any hooks return a truthy value, it is an error and we abort
  // be very careful with calling hooks from within a hook, infinite loops are possible
  callHooks(hook, argv) {
    // _.find() used instead of _.each() because we want to break out as soon
    // as a hook returns a truthy value (used to indicate an error, e.g. in form
    // of a string)
    let err = null;

    this.logger.silly('callHooks(' + hook +
          (argv ? ', ' + util.inspect(argv) + ')' : ')'));

    _.find(this.plugins, plugin => {
      if (plugin.hooks[hook]) {
        const fun = plugin.hooks[hook];
        err = fun.apply(null, argv);
        return err;
      }
    });

    return err;
  }

  // returns number of hook functions attached to given hook
  numHooks(hook) {
    let cnt = 0;

    _.find(this.plugins, plugin => {
      if (plugin[hook]) {
        cnt++;
      }
    });

    return cnt;
  }

  /**
   * Returns currently playing song
   * @return {Song|null} - Song object, null if no now playing song
   */
  getNowPlaying() {
    return this.nowPlaying;
  }

  // TODO: handling of pause in a good way?
  /**
   * Stop playback of current song
   * @param {Boolean} [pause=false] - If true, don't reset song position
   */
  stopPlayback(pause) {
    this.logger.info('playback ' + (pause ? 'paused.' : 'stopped.'));

    clearTimeout(this.songEndTimeout);
    this.play = false;

    const np = this.nowPlaying;
    const pos = np.playback.startPos + (new Date().getTime() - np.playback.startTime);
    if (np) {
      np.playback = {
        startTime: 0,
        startPos:  pause ? pos : 0,
      };
    }
  }

  /**
   * Start playing now playing song, at optional position
   * @param {Number} [position=0] - Position at which playback is started
   * @throws {Error} if an error occurred
   */
  startPlayback(position) {
    position = position || 0;
    const player = this;

    if (!this.nowPlaying) {
      // find first song in queue
      this.nowPlaying = this.queue.songs[0];

      if (!this.nowPlaying) {
        throw new Error('queue is empty! not starting playback.');
      }
    }

    this.nowPlaying.prepare(err => {
      if (err) {
        throw new Error('error while preparing now playing: ' + err);
      }

      player.nowPlaying.playbackStarted(position || player.nowPlaying.playback.startPos);

      player.logger.info('playback started.');
      player.play = true;
    });
  }

  /**
   * Change to song
   * @param {String} uuid - UUID of song to change to, if not found in queue, now
   *                        playing is removed, playback stopped
   */
  changeSong(uuid) {
    this.logger.verbose('changing song to: ' + uuid);
    clearTimeout(this.songEndTimeout);

    this.nowPlaying = this.queue.findSong(uuid);

    if (!this.nowPlaying) {
      this.logger.info('song not found: ' + uuid);
      this.stopPlayback();
    }

    this.startPlayback();
    this.logger.info('changed song to: ' + uuid);
  }

  songEnd() {
    const np = this.getNowPlaying();
    const npIndex = np ? this.queue.findSongIndex(np.uuid) : -1;

    this.logger.info('end of song ' + np.uuid);
    this.callHooks('onSongEnd', [np]);

    const nextSong = this.queue.songs[npIndex + 1];
    if (nextSong) {
      this.changeSong(nextSong.uuid);
    } else {
      this.logger.info('hit end of queue.');

      if (this.repeat) {
        this.logger.info('repeat is on, restarting playback from start of queue.');
        this.changeSong(this.queue.uuidAtIndex(0));
      }
    }

    this.prepareSongs();
  }

  // TODO: move these to song class?
  setPrepareTimeout(song) {
    const player = this;

    if (song.prepareTimeout) {
      clearTimeout(song.prepareTimeout);
    }

    song.prepareTimeout = setTimeout(() => {
      player.logger.info('prepare timeout for song: ' + song.songId + ', removing');
      song.cancelPrepare('prepare timeout');
      song.prepareTimeout = null;
    }, this.config.songPrepareTimeout);

    Object.defineProperty(song, 'prepareTimeout', {
      enumerable: false,
      writable:   true,
    });
  }

  clearPrepareTimeout(song) {
    // clear prepare timeout
    clearTimeout(song.prepareTimeout);
    song.prepareTimeout = null;
  }

  prepareError(song, err) {
    // TODO: mark song as failed
    this.callHooks('onSongPrepareError', [song, err]);
  }

  prepareProgCallback(song, bytesWritten, done) {
    /* progress callback
     * when this is called, new song data has been flushed to disk */

    // start playback if it hasn't been started yet
    if (this.play && this.getNowPlaying() &&
              this.getNowPlaying().uuid === song.uuid &&
              !this.queue.playbackStart && bytesWritten) {
      this.startPlayback();
    }

    // tell plugins that new data is available for this song, and
    // whether the song is now fully written to disk or not.
    this.callHooks('onPrepareProgress', [song, bytesWritten, done]);

    if (done) {
      // mark song as prepared
      this.callHooks('onSongPrepared', [song]);

      // done preparing, can't cancel anymore
      delete (song.cancelPrepare);

      // song data should now be available on disk, don't keep it in memory
      song.backend.songsPreparing[song.songId].songData = undefined;
      delete (song.backend.songsPreparing[song.songId]);

      // clear prepare timeout
      this.clearPrepareTimeout(song);
    } else {
      // reset prepare timeout
      this.setPrepareTimeout(song);
    }
  }

  prepareErrCallback(song, err, callback) {
    /* error callback */

    // don't let anything run cancelPrepare anymore
    delete (song.cancelPrepare);

    this.clearPrepareTimeout(song);

    // abort preparing more songs; current song will be deleted ->
    // onQueueModified is called -> song preparation is triggered again
    callback(true);

    // TODO: investigate this, should probably be above callback
    this.prepareError(song, err);

    song.songData = undefined;
    delete (this.songsPreparing[song.backend.name][song.songId]);
  }

  prepareSong(song, callback) {
    const self = this;

    if (!song) {
      throw new Error('prepareSong() without song');
    }

    if (song.isPrepared()) {
      // start playback if it hasn't been started yet
      if (this.play && this.getNowPlaying() &&
                  this.getNowPlaying().uuid === song.uuid &&
                  !this.queue.playbackStart) {
        this.startPlayback();
      }

      // song is already prepared, ok to prepare more songs
      callback();
    } else {
      // song is not prepared and not currently preparing: let backend prepare it
      this.logger.debug('DEBUG: prepareSong() ' + song.songId);

      song.prepare((err, chunk, done) => {
        if (err) {
          return callback(err);
        }

        if (chunk) {
          self.prepareProgCallback(song, chunk, done);
        }

        if (done) {
          self.clearPrepareTimeout(song);
          callback();
        }
      });

      this.setPrepareTimeout(song);
    }
  }

  /**
   * Prepare now playing and next song for playback
   */
  prepareSongs() {
    const player = this;

    let currentSong;
    async.series([
      callback => {
        // prepare now-playing song
        currentSong = player.getNowPlaying();
        if (currentSong) {
          player.prepareSong(currentSong, callback);
        } else if (player.queue.getLength()) {
          // songs exist in queue, prepare first one
          currentSong = player.queue.songs[0];
          player.prepareSong(currentSong, callback);
        } else {
          // bail out
          callback(true);
        }
      },
      callback => {
        // prepare next song in playlist
        const nextSong = player.queue.songs[player.queue.findSongIndex(currentSong) + 1];
        if (nextSong) {
          player.prepareSong(nextSong, callback);
        } else {
          // bail out
          callback(true);
        }
      },
    ]);
    // TODO where to put this
    // player.prepareErrCallback();
  }

  getPlaylists(callback) {
    let resultCnt = 0;
    const allResults = {};
    const player = this;

    _.each(this.backends, backend => {
      if (!backend.getPlaylists) {
        resultCnt++;

        // got results from all services?
        if (resultCnt >= Object.keys(player.backends).length) {
          callback(allResults);
        }
        return;
      }

      backend.getPlaylists((err, results) => {
        resultCnt++;

        allResults[backend.name] = results;

        // got results from all services?
        if (resultCnt >= Object.keys(player.backends).length) {
          callback(allResults);
        }
      });
    });
  }

  // make a search query to backends
  searchBackends(query, callback) {
    let resultCnt = 0;
    const allResults = {};

    _.each(this.backends, backend => {
      backend.search(query, _.bind(results => {
        resultCnt++;

        // make a temporary copy of songlist, clear songlist, check
        // each song and add them again if they are ok
        const tempSongs = _.clone(results.songs);
        allResults[backend.name] = results;
        allResults[backend.name].songs = {};

        _.each(tempSongs, song => {
          const err = this.callHooks('preAddSearchResult', [song]);
          if (err) {
            this.logger.error('preAddSearchResult hook error: ' + err);
          } else {
            allResults[backend.name].songs[song.songId] = song;
          }
        }, this);

        // got results from all services?
        if (resultCnt >= Object.keys(this.backends).length) {
          callback(allResults);
        }
      }, this), _.bind(err => {
        resultCnt++;
        this.logger.error('error while searching ' + backend.name + ': ' + err);

        // got results from all services?
        if (resultCnt >= Object.keys(this.backends).length) {
          callback(allResults);
        }
      }, this));
    }, this);
  }

  // TODO: userID does not belong into core...?
  setVolume(newVol, userID) {
    newVol = Math.min(1, Math.max(0, newVol));
    this.volume = newVol;
    this.callHooks('onVolumeChange', [newVol, userID]);
  }
}
