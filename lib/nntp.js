"use strict";

var tls = require('tls'), net = require('net');
var async = require('async');

var ENCODING = 'utf8';
var RE_LINE = /^(\d\d\d) (.*)\r\n$/;
var MAX_RECV_SIZE = 16384; // 16KB should be *plenty* of space for a response

//exports.log = {info: console.info.bind(console), warn: console.warn.bind(console), debug: console.log.bind(console)};
exports.log = null;

var commands = {
	POST: new Buffer('POST\r\n'),
	AUTH_USER: new Buffer('AUTHINFO USER '),
	AUTH_PASS: new Buffer('AUTHINFO PASS '),
	CRLF: new Buffer('\r\n')
};

var checkExpect = function(expected, name, code, info) {
	if(code != expected)
		return new Error('Unexpected response to '+name+' (code: ' + code + '): ' + info);
};

function NNTP(opts) {
	this.opts = opts;
	this.dataQueue = [];
	this._connectRetries = opts.connectRetries;
	
	if(!this.opts.connect.port)
		this.opts.connect.port = this.opts.secure ? 563 : 119;
	// TODO: consider STARTTLS support??
}

NNTP.prototype = {
	state: 'inactive',
	socket: null,
	_timer: null,
	_finished: false,
	_requesting: false,
	_requestingFunc: null,
	_respFunc: null,
	_lastError: null,
	_postRetries: null,
	canPost: null,
	currentGroup: null,
	
	connect: function(cb) {
		this.state = 'connecting';
		this._lastError = null;
		this._finished = false;
		
		cb = cb || function() {};
		
		// if rescheduling request, save a copy
		var reschedReq = this._requesting;
		var reschedReqFunc = this._requestingFunc;
		this._requesting = false;
		this._respFunc = null;
		if(this._timer) this._clearTimer(); // if request timer is active, clear it
		
		this._setTimer(function() {
			if(this._connectRetries--) {
				this._destroy();
				this.warn('NNTP connection timed out, reconnecting after ' +(this.reconnectDelay/1000)+ ' second(s)...');
				this._setTimer(this.connect.bind(this, cb), this.reconnectDelay);
			} else {
				this.destroy();
				cb(new Error('NNTP connection timeout'));
			}
		}.bind(this), this.opts.connTimeout);
		
		var self = this;
		// TODO: investigate options
		async.waterfall([
			function(cb) {
				var factory = (self.opts.secure ? tls : net);
				self.socket = factory.connect(self.opts.connect, cb);
				self.socket.setTimeout(0); // ???
				self.debug('Connecting to nntp' + (self.opts.secure ? 's':'') + '://' + self.opts.connect.host + ':' + self.opts.connect.port + '...');
				
				self.socket.once('end', self._onError.bind(self));
				self.socket.once('close', self._onClose.bind(self));
				self.socket.once('error', self._onError.bind(self));
				self.socket.on('data', self._onData.bind(self));
			},
			function(cb) {
				if(self._lastError) return cb(self._lastError);
				self._clearTimer();
				self._request(null, cb);
			},
			function(code, info, cb) {
				if(self._lastError) return cb(self._lastError);
				
				self.debug('NNTP connection established');
				if(code == 201) {
					self.canPost = false;
					self.debug('NNTP server won\'t accept posts');
				} else {
					var err = checkExpect(200, 'connect', code, info);
					if(err) return cb(err);
					self.canPost = true;
				}
				if(self.opts.user) {
					self.state = 'auth';
					
					self.socket.write(commands.AUTH_USER);
					self.socket.write(self.opts.user, ENCODING);
					self._request(commands.CRLF, cb);
				} else cb(null, null, null);
			},
			function(code, info, cb) {
				if(self.opts.user) {
					if(self._lastError) return cb(self._lastError);
					
					var err = checkExpect(381, 'auth user', code, info);
					if(err) return cb(err);
					self.socket.write(commands.AUTH_PASS);
					self.socket.write(self.opts.password, ENCODING);
					self._request(commands.CRLF, cb);
				} else cb(null, null, null);
			},
			function(code, info, cb) {
				if(self.opts.user) {
					if(self._lastError) return cb(self._lastError);
					
					var err = checkExpect(281, 'auth pass', code, info);
					if(err) return cb(err);
					
					self.debug('NNTP connection authenticated');
					cb();
				} else cb();
			},
			function(cb) {
				// group previously selected - re-select it
				if(self.currentGroup) {
					self.state = 'connected'; // hack to force request through
					self.group(self.currentGroup, cb);
				} else cb();
			}
		], function(err) {
			if(err) {
				self._destroy();
				self._lastError = null;
				return cb(err);
			}
			self.state = 'connected';
			self.debug('NNTP connection ready');
			self._connectRetries = self.opts.connectRetries; // reset connect retry counter
			if(reschedReq) {
				// rescheduled request
				self[reschedReqFunc].apply(self, reschedReq);
			}
			cb();
		});
	},
	_onClose: function(had_error) {
		this.state = 'disconnected';
		this.debug('NNTP connection closed');
	},
	_onError: function(err) {
		this._lastError = err;
		if(!this._finished) {
			if(err) {
				this.warn('NNTP connection error occurred: ' + err);
			} else {
				this.warn('NNTP connection unexpectedly lost, reconnecting...');
			}
			this._destroy();
			this.connect(function(err) {
				// could not reconnect, even after retries... :(
				// TODO: do we need to do anything here?
			});
		}
	},
	_onData: function(chunk) {
		// grab incomming lines
		var data = chunk.toString(ENCODING); // TODO: perhaps should be ASCII encoding always?
		var p;
		var whileFunc = function() {
			if((p = data.indexOf('\r\n')) >= 0) return true;
			// check annoying case of a \r and \n in separate chunks
			if(!this.dataQueue.length) return false;
			if(data[0] == '\n' && this.dataQueue[this.dataQueue.length-1].substr(-1) == '\r') {
				p = -1;
				return true;
			}
			return false;
		}.bind(this);
		while(whileFunc()) {
			var line = this.dataQueue.join('') + data.substr(0, p+2);
			data = data.substr(p+2);
			this.dataQueue = [];
			
			var m = line.match(RE_LINE);
			if(m && (m[1] == '400' || m[1] == '205'))
				// ignore '400 idle for too long' and '205 Connection closing' messages
				continue;
			if(this._respFunc) {
				var rf = this._respFunc;
				this._respFunc = null;
				if(m)
					rf(null, m[1]|0, m[2].trim());
				else
					rf(new Error('Unexpected line format: ' + line));
			} else {
				this.warn('Unexpected response received: ' + line);
			}
		}
		// TODO: check max packet size so that a rouge server doesn't overwhelm our memory
		if(data.length) this.dataQueue.push(data);
	},
	end: function() {
		if(this._finished) return;
		this._finished = true;
		if(this.socket) {
			this.socket.end('QUIT\r\n');
		}
		this.socket = null;
		if(!this._requesting && this._timer) {
			this._clearTimer();
		}
		this.state = 'closing';
	},
	destroy: function() {
		this._finished = true;
		if(this._respFunc)
			this._respFunc(new Error('Connection closed'));
		this._destroy();
	},
	_destroy: function() {
		if(this._timer) 
			this._clearTimer();
		this._respFunc = null;
		
		if(this.socket) {
			this.socket.destroy();
			this.socket.removeAllListeners();
			this.socket = null;
		}
		this.state = 'disconnected';
	},
	date: function(cb) {
		this._doRequest('DATE\r\n', function(err, code, info) {
			if(!err) err = checkExpect(111, 'DATE', code, info);
			if(err) return cb(err);
			var m = info.match(/^(\d\d\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/);
			var date;
			if(m) date = new Date(m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6]);
			if(!date || isNaN(date)) return cb(new Error('Invalid date returned: ' + info));
			cb(null, date);
		});
	},
	// group cannot contain newlines
	group: function(group, cb) {
		this._doRequest('GROUP ' + group + '\r\n', function(err, code, info) {
			if(code == 411) return cb(new Error('Selected group does not exist'));
			if(!err) err = checkExpect(211, 'GROUP', code, info);
			if(err) return cb(err);
			
			// TODO: consider parsing returned packet
			// format: 211 num_articles_estimate first_num last_num group_name
			this.currentGroup = group;
			cb(null);
		}.bind(this));
	},
	// id cannot contain newlines
	stat: function(id, cb) {
		if(typeof id != 'number')
			id = '<' + id + '>'; // handle message ID
		this._doRequest('STAT ' + id + '\r\n', function(err, code, info) {
			if(err) return cb(err);
			// TODO: error 412 no newsgroup has been selected
			if(code == 423 || code == 430) return cb(null, null); // no such article
			
			var err = checkExpect(223, 'STAT', code, info);
			if(err) return cb(err);
			
			var m = info.match(/^(\d+) <(.*?)>/);
			if(!m) cb(new Error('Unexpected response for stat request: ' + info));
			else cb(null, [m[1]|0, m[2]]);
		});
	},
	// NOTE: msg MUST end with \r\n.\r\n
	post: function(msg, cb) {
		if(!this.canPost) return cb(new Error('Server has indicated that posting is not allowed'));
		this._postRetries = this.opts.postRetries;
		var self = this;
		(function doPost() {
			self._doRequest(commands.POST, function(err, code, info) {
				if(!err) err = checkExpect(340, 'POST', code, info);
				if(err) return cb(err);
				
				// mark this request to be retried if disconnected
				self._requesting = [msg, cb];
				self._requestingFunc = 'post';
				self._request(msg, function(err, code, info) {
					if(err) return cb(err);
					if(code == 441) {
						if(self._postRetries > 0) {
							self._postRetries--;
							return doPost();
						}
						return cb(new Error('Server could not accept post, returned: ' + code + ' ' + info));
					}
					var err = checkExpect(240, 'posted article', code, info);
					if(err) return cb(err);
					
					var m = info.match(/^<(.*)> Article received ok$/i);
					if(m)
						cb(null, m[1]);
					else
						cb(new Error('Unexpected response for posted article: ' + info));
				});
				
			});
		})();
	},
	_doRequest: function(msg, cb) {
		// TODO: check that this works on connection errors
		if(this._requesting)
			throw new Error('Request made whilst another request is in progress');
		this._requesting = [msg, cb]; // this marks that the request should be retried if a disconnect occurs
		this._requestingFunc = '_request';
		if(this.state == 'connected') {
			this._request(msg, cb);
		}
		// otherwise, request is scheduled on connect
	},
	_request: function(msg, cb) {
		var self = this;
		// TODO: debug output
		this._setTimer(function() {
			self._requesting = false;
			self._respFunc = null;
			cb(new Error('Response timed out'));
		}, this.opts.timeout);
		this._respFunc = function() {
			self._requesting = false;
			self._clearTimer();
			cb.apply(null, arguments);
		};
		if(msg) this.socket.write(msg);
	},
	
	_setTimer: function(func, time) {
		this._timer = setTimeout(function() {
			this._timer = null;
			func();
		}, time);
	},
	_clearTimer: function() {
		clearTimeout(this._timer);
		this._timer = null;
	},
	// TODO: check logging usage
	warn: function(msg) {
		if(exports.log) exports.log.warn(msg);
	},
	info: function(msg) {
		if(exports.log) exports.log.info(msg);
	},
	debug: function(msg) {
		if(exports.log) exports.log.debug(msg);
	}
};

module.exports = NNTP;