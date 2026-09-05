const https = require('https');
const _baseURL = 'https://www.link-tap.com/api/';
const RATE_LIMIT_MS = 15000;        // activateInstantMode: min 15s between calls
const MIN_POLL_MINUTES = 5;         // getAllDevices: manufacturer limits status polling to every 5 min
const DEFAULT_POLL_MINUTES = 15;    // default refresh; raise/lower via pollInterval. 5 = API minimum
const LOW_BATTERY_THRESHOLD = 20;   // percent at or below which HomeKit shows a low-battery warning
var Service, Characteristic;
var debug = require('debug')('linktap');

var username, apiKey, gatewayId;

// Parse a battery/signal value that may arrive as a number (85) or a string ("85%")
function parsePercent(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Math.max(0, Math.min(100, Math.round(val)));
  var m = String(val).match(/(\d+(\.\d+)?)/);
  return m ? Math.max(0, Math.min(100, Math.round(parseFloat(m[1])))) : null;
}

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  // Define custom characteristics once, at registration time
  class DurationTimer extends Characteristic {
    constructor() {
      super('Duration Timer', 'CDC6551D-2D1B-4CC1-A5AE-0200844A7BC3');
      this.setProps({
        format: 'int',
        unit: 's',
        perms: ['pr', 'pw'],
        minValue: 60,
        maxValue: 86340,
      });
      this.value = this.getDefaultValue();
    }
  }
  DurationTimer.UUID = 'CDC6551D-2D1B-4CC1-A5AE-0200844A7BC3';
  Characteristic.DurationTimer = DurationTimer;

  class WaterVolume extends Characteristic {
    constructor() {
      super('Water Volume', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
      this.setProps({
        format: 'float',
        unit: 'litre',
        minValue: 0,
        maxValue: 1000000,
        minStep: 0.1,
        perms: ['pr', 'ev']
      });
      this.value = this.getDefaultValue();
    }
  }
  WaterVolume.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
  Characteristic.WaterVolume = WaterVolume;

  homebridge.registerPlatform("homebridge-platform-linktap", "LinkTapPlatform", LinkTapPlatform);
};

function LinkTapPlatform(log, config, api) {
  this.log = log;

  if (!config) {
    this.log.warn("Ignoring LinkTap Platform setup because it is not configured");
    this.disabled = true;
    return;
  }
  this.config = config;
  this.verboseStatusLog = config.verboseStatusLog === true;

  this.api = api;

  username = config.username || "default";
  apiKey = config.apiKey || "default";
  gatewayId = config.gatewayId || "default";
}

LinkTapPlatform.prototype.accessories = function(callback) {
  var that = this;
  that.accessoryList = [];

  if (!that.config.taps || !Array.isArray(that.config.taps)) {
    that.log.warn("No 'taps' array found in config - check your LinkTap configuration");
    callback(that.accessoryList);
    return;
  }

  that.config.taps.forEach(function(tap) {
    that.accessoryList.push(new LinkTapAccessory(that.log, tap, that));
  });
  callback(that.accessoryList);

  that._startPolling();
};

LinkTapPlatform.prototype._startPolling = function() {
  var that = this;
  var minutes = this.config.pollInterval;

  if (minutes === 0) {
    this.log("Status polling disabled (pollInterval = 0); battery and signal will not update");
    return;
  }
  if (minutes === undefined || minutes === null) minutes = DEFAULT_POLL_MINUTES;
  if (minutes < MIN_POLL_MINUTES) {
    this.log.warn("pollInterval %d is below the API minimum of %d minutes; using %d",
      minutes, MIN_POLL_MINUTES, MIN_POLL_MINUTES);
    minutes = MIN_POLL_MINUTES;
  }

  var intervalMs = minutes * 60 * 1000;
  this.log("Polling LinkTap status every %d minute(s) for battery and signal", minutes);

  setTimeout(function() { that._pollStatus(); }, 10000);
  this._pollTimer = setInterval(function() { that._pollStatus(); }, intervalMs);
};

LinkTapPlatform.prototype._pollStatus = function() {
  var that = this;
  this._fetchDevices(function(err, parsed) {
    if (err) {
      that.log.error("getAllDevices request failed: %s", err.message);
      return;
    }
    that._applyStatus(parsed);
  });
};

LinkTapPlatform.prototype._fetchDevices = function(callback) {
  var body = JSON.stringify({ username: username, apiKey: apiKey });

  var req = https.request(_baseURL + "getAllDevices", {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    var responseBody = '';
    res.on('data', function(chunk) { responseBody += chunk; });
    res.on('end', function() {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return callback(new Error("getAllDevices returned HTTP " + res.statusCode));
      }
      try {
        callback(null, JSON.parse(responseBody));
      } catch (e) {
        callback(new Error("Failed to parse getAllDevices response: " + e.message));
      }
    });
  });

  req.on('error', function(err) { callback(err); });
  req.write(body);
  req.end();
};

LinkTapPlatform.prototype.fetchLiveMode = function(taplinkerId, callback) {
  this._fetchDevices(function(err, parsed) {
    if (err) return callback(err);
    var gateways = parsed.devices || parsed.deviceList || [];
    var mode = null;
    gateways.forEach(function(gw) {
      var list = gw.taplinker || gw.deviceList || gw.devices || [];
      list.forEach(function(d) {
        var id = d.taplinkerId || d.deviceId || d.id;
        if (id && String(id).toUpperCase() === String(taplinkerId).toUpperCase() && d.workMode !== undefined) {
          mode = WORKMODE_TO_SCHEDULE[d.workMode] || null;
        }
      });
    });
    callback(null, mode);
  });
};

LinkTapPlatform.prototype._applyStatus = function(parsed) {
  var that = this;

  var gateways = parsed.devices || parsed.deviceList || [];
  var taplinkers = [];

  gateways.forEach(function(gw) {
    var list = gw.taplinker || gw.deviceList || gw.devices || [];
    list.forEach(function(d) { taplinkers.push(d); });
  });

  if (taplinkers.length === 0) {
    debug("getAllDevices returned no taplinkers to match");
    return;
  }

  taplinkers.forEach(function(d) {
    var id = d.taplinkerId || d.deviceId || d.id;
    if (!id) return;

    var accessory = that.accessoryList.find(function(a) {
      return a.taplinkerId && a.taplinkerId.toUpperCase() === String(id).toUpperCase();
    });
    if (!accessory) return;

    var battery = parsePercent(d.batteryStatus !== undefined ? d.batteryStatus : d.battery);
    var signal = parsePercent(d.signal);
    var online;
    if (d.status !== undefined) {
      online = (d.status === true || d.status === 'Connected' || d.status === 'online');
    }

    var watering;
    if (d.watering !== undefined) {
      watering = (d.watering !== null && d.watering !== false);
    }

    var fault;
    var faultFlags = [
      d.noWater, d.valveBroken, d.fall, d.fallFlag, d.leakFlag, d.clogFlag, d.pcFlag, d.pbFlag, d.freeze, d.freezeFlag, d.frzFlag
    ];
    var anyFaultField = faultFlags.some(function(v) { return v !== undefined; });
    if (anyFaultField || d.alert !== undefined || d.alerts !== undefined) {
      fault = faultFlags.some(function(v) { return v === true || v === 1 || v === 'true'; });
      if (!fault && d.alert) fault = true;
      if (!fault && Array.isArray(d.alerts) && d.alerts.length > 0) fault = true;
    }

    var volumeMl;
    if (d.vol !== undefined && typeof d.vol === 'number') {
      volumeMl = d.vol;
    } else if (d.vel !== undefined && typeof d.vel === 'number') {
      volumeMl = d.vel;
    }

    if (d.workMode !== undefined) {
      var mapped = WORKMODE_TO_SCHEDULE[d.workMode];
      if (mapped) accessory._detectedMode = mapped;
    }

    var paused;
    if (d.watactivated !== undefined) {
      paused = (d.watactivated === false);
    } else if (d.paused !== undefined) {
      paused = (d.paused === true || d.paused === 1);
    } else if (d.pause !== undefined) {
      paused = (d.pause === true || d.pause === 1 || (typeof d.pause === 'object' && d.pause !== null));
    }

    accessory.updateStatus(battery, signal, online, watering, fault, paused, volumeMl);
  });
};

function LinkTapAccessory(log, tap, platform) {
  this.log = log;
  this.platform = platform;

  this.name = tap.name;
  this.location = tap.location;
  this.taplinkerId = tap.taplinkerId;
  this.duration = (typeof tap.duration === 'number' && tap.duration >= 1) ? tap.duration : 10;
  this._durationInSeconds = this.duration * 60;
  this.autoBack = tap.autoBack !== undefined ? tap.autoBack : true;
  this.useValve = tap.useValve !== undefined ? tap.useValve : true;
  this.pauseHours = tap.pauseHours !== undefined ? tap.pauseHours : 24;
  this.scheduleMode = tap.scheduleMode || 'sevenDay';
  this._detectedMode = null;

  this._lastApiCall = 0;
  this._pendingOffTimer = null;

  this._active = 0;
  this._inUse = 0;
  this._paused = 0;

  this._batteryLevel = 100;
  this._statusLowBattery = 0;
  this._signal = 100;
  this._online = true;
  this._volume = 0;
  this._fault = 0;

  this.log("Found LinkTap: %s [%s]", this.name, this.taplinkerId);

  this._service = this.getTapService();
  this._batteryService = this.getBatteryService();
  this._faultService = this.getFaultService();
  this._scheduleService = this.getScheduleService();
}

LinkTapAccessory.prototype.getServices = function() {
  var informationService = new Service.AccessoryInformation();
  informationService
    .setCharacteristic(Characteristic.Manufacturer, "LinkTap")
    .setCharacteristic(Characteristic.Model, "LinkTap Wireless Water Timer")
    .setCharacteristic(Characteristic.SerialNumber, this.taplinkerId);
  this.informationService = informationService;

  return [informationService, this._service, this._batteryService, this._faultService, this._scheduleService];
};

LinkTapAccessory.prototype.getTapService = function() {
  var tapService;

  if (this.useValve) {
    tapService = new Service.Valve(this.name);

    tapService.getCharacteristic(Characteristic.Active)
      .on('set', this._setActive.bind(this))
      .on('get', function(cb) { cb(null, this._active); }.bind(this));

    tapService.getCharacteristic(Characteristic.InUse)
      .on('get', function(cb) { cb(null, this._inUse); }.bind(this));

    tapService.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
  } else {
    tapService = new Service.Switch(this.name);

    tapService.getCharacteristic(Characteristic.On)
      .on('set', this._setSwitchOn.bind(this))
      .on('get', function(cb) { cb(null, this._active === 1); }.bind(this));
  }

  tapService.addCharacteristic(new Characteristic.DurationTimer());
  tapService.updateCharacteristic(Characteristic.DurationTimer, this._durationInSeconds);
  tapService.getCharacteristic(Characteristic.DurationTimer)
    .on('get', this._getDurationTimerValue.bind(this))
    .on('set', this._setDurationTimerValue.bind(this));

  tapService.addCharacteristic(Characteristic.StatusFault);
  tapService.getCharacteristic(Characteristic.StatusFault)
    .on('get', function(cb) { cb(null, this._online ? 0 : 1); }.bind(this));

  tapService.addCharacteristic(new Characteristic.WaterVolume());
  tapService.getCharacteristic(Characteristic.WaterVolume)
    .on('get', function(cb) { cb(null, this._volume); }.bind(this));

  return tapService;
};

LinkTapAccessory.prototype.getScheduleService = function() {
  var pauseService = new Service.Switch(this.name + " Pause Schedule");
  pauseService.getCharacteristic(Characteristic.On)
    .on('get', function(cb) { cb(null, this._paused === 1); }.bind(this))
    .on('set', this._setSchedule.bind(this));
  return pauseService;
};

LinkTapAccessory.prototype.getFaultService = function() {
  var faultService = new Service.LeakSensor(this.name + " Alert");
  faultService.getCharacteristic(Characteristic.LeakDetected)
    .on('get', function(cb) { cb(null, this._fault); }.bind(this));
  return faultService;
};

LinkTapAccessory.prototype.getBatteryService = function() {
  var BatteryService = Service.Battery || Service.BatteryService;
  var batteryService = new BatteryService(this.name + " Battery");

  batteryService.getCharacteristic(Characteristic.BatteryLevel)
    .on('get', function(cb) { cb(null, this._batteryLevel); }.bind(this));

  batteryService.getCharacteristic(Characteristic.StatusLowBattery)
    .on('get', function(cb) { cb(null, this._statusLowBattery); }.bind(this));

  batteryService.setCharacteristic(
    Characteristic.ChargingState,
    Characteristic.ChargingState.NOT_CHARGEABLE
  );

  return batteryService;
};

LinkTapAccessory.prototype.updateStatus = function(batteryPct, signalPct, online, watering, fault, paused, volumeMl) {
  if (batteryPct !== null && batteryPct !== undefined) {
    this._batteryLevel = batteryPct;
    this._statusLowBattery = batteryPct <= LOW_BATTERY_THRESHOLD ? 1 : 0;
    if (this._batteryService) {
      this._batteryService.updateCharacteristic(Characteristic.BatteryLevel, this._batteryLevel);
      this._batteryService.updateCharacteristic(Characteristic.StatusLowBattery, this._statusLowBattery);
    }
  }

  if (signalPct !== null && signalPct !== undefined) {
    this._signal = signalPct;
  }

  if (online !== null && online !== undefined) {
    if (online !== this._online) {
      this.log("%s is now %s", this.name, online ? "online" : "offline");
    }
    this._online = online;
    if (this._service) {
      this._service.updateCharacteristic(Characteristic.StatusFault, online ? 0 : 1);
    }
  }

  if (watering !== null && watering !== undefined) {
    var newInUse = watering ? 1 : 0;
    if (newInUse !== this._inUse) {
      this.log("%s %s", this.name, watering ? "started watering" : "stopped watering");
      this._inUse = newInUse;
      this._active = newInUse;
      this._reflectWateringState();
      if (!watering) this._resetTimer();
    }
  }

  if (fault !== null && fault !== undefined) {
    this._fault = fault ? 1 : 0;
    if (this._faultService) {
      this._faultService.updateCharacteristic(Characteristic.LeakDetected, this._fault);
    }
    if (this._fault) this.log.warn("%s reported an alert/fault condition", this.name);
  }

  if (paused !== null && paused !== undefined) {
    var newPaused = paused ? 1 : 0;
    if (newPaused !== this._paused) {
      this._paused = newPaused;
      if (this._scheduleService) {
        this._scheduleService.updateCharacteristic(Characteristic.On, this._paused === 1);
      }
    }
  }

  if (volumeMl !== null && volumeMl !== undefined) {
    var litres = Math.round((volumeMl / 1000) * 10) / 10;
    if (litres !== this._volume) {
      this._volume = litres;
      if (this._service) {
        this._service.updateCharacteristic(Characteristic.WaterVolume, this._volume);
      }
    }
  }

  var statusLog = (this.platform && this.platform.verboseStatusLog) ? this.log.bind(this) : debug;
  statusLog("%s status: battery %s%%, signal %s%%, %s%s%s",
    this.name, this._batteryLevel, this._signal,
    this._online ? "online" : "offline",
    (watering !== undefined ? (watering ? ", watering" : ", idle") : ""),
    (this._fault ? ", ALERT" : ""));
};

LinkTapAccessory.prototype.identify = function(callback) {
  this.log("%s - Identify", this.name);
  callback();
};

LinkTapAccessory.prototype._setActive = function(value, callback) {
  var on = (value === Characteristic.Active.ACTIVE || value === 1);
  this._active = on ? 1 : 0;
  this._inUse = on ? 1 : 0;

  if (this._service) {
    this._service.updateCharacteristic(Characteristic.InUse, this._inUse);
  }

  this.turnOnTheTap(on, callback);
};

LinkTapAccessory.prototype._setSwitchOn = function(value, callback) {
  var on = (value === true || value === 1);
  this._active = on ? 1 : 0;
  this._inUse = on ? 1 : 0;
  this.turnOnTheTap(on, callback);
};

LinkTapAccessory.prototype._reflectWateringState = function() {
  if (!this._service) return;
  if (this.useValve) {
    this._service.updateCharacteristic(Characteristic.InUse, this._inUse);
    this._service.updateCharacteristic(Characteristic.Active, this._active);
  } else {
    this._service.updateCharacteristic(Characteristic.On, this._active === 1);
  }
};

LinkTapAccessory.prototype.turnOnTheTap = function(on, callback) {
  this.log("Setting tap state to " + on);
  debug("Request for taplinker %s (gateway %s)", this.taplinkerId, gatewayId);

  if (this._pendingOffTimer) {
    clearTimeout(this._pendingOffTimer);
    this._pendingOffTimer = null;
  }

  this._resetTimer();

  if (on) {
    this._sendInstantMode(true, callback);
    this._startTimer();
  } else {
    var elapsed = Date.now() - this._lastApiCall;
    if (elapsed >= RATE_LIMIT_MS) {
      this._sendInstantMode(false, callback);
    } else {
      var wait = RATE_LIMIT_MS - elapsed;
      this.log("Off command deferred %dms to respect LinkTap's 15s rate limit", wait);
      this._pendingOffTimer = setTimeout(function() {
        this._pendingOffTimer = null;
        this._sendInstantMode(false, null);
      }.bind(this), wait);
      callback();
    }
  }
};

LinkTapAccessory.prototype._sendInstantMode = function(on, callback) {
  var self = this;
  var durationMinutes = Math.max(1, Math.round(this._durationInSeconds / 60));
  var data = {
    username: username,
    apiKey: apiKey,
    gatewayId: gatewayId,
    taplinkerId: this.taplinkerId,
    action: on,
    duration: on ? durationMinutes : 0,
    autoBack: this.autoBack
  };

  var body = JSON.stringify(data);
  debug("activateInstantMode body %s", body);
  this._lastApiCall = Date.now();

  var req = https.request(_baseURL + "activateInstantMode", {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    var responseBody = '';
    res.on('data', function(chunk) { responseBody += chunk; });
    res.on('end', function() {
      debug('STATUS: ', res.statusCode, responseBody);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (callback) callback();
      } else {
        var err = new Error("LinkTap API returned HTTP " + res.statusCode);
        self.log.error(err.message);
        if (callback) callback(err);
      }
    });
  });

  req.on('error', function(error) {
    self.log.error("LinkTap API request failed: %s", error.message);
    if (callback) callback(error);
  });

  req.write(body);
  req.end();
};

LinkTapAccessory.prototype._setSchedule = function(value, callback) {
  var pause = (value === true || value === 1);
  this._paused = pause ? 1 : 0;
  if (pause) {
    this._pauseWateringPlan(callback);
  } else {
    this._resumeWateringPlan(callback);
  }
};

var SCHEDULE_MODE_ENDPOINTS = {
  SevenDay: 'activateSevenDayMode',
  Interval: 'activateIntervalMode',
  OddEven: 'activateOddEvenMode',
  Month: 'activateMonthMode',
  Calendar: 'activateCalendarMode'
};

var WORKMODE_TO_SCHEDULE = {
  'I': 'interval',
  'T': 'sevenDay',
  'O': 'oddEven',
  'D': 'calendar',
  'Y': 'month'
};

LinkTapAccessory.prototype._pauseWateringPlan = function(callback) {
  var data = {
    username: username,
    apiKey: apiKey,
    gatewayId: gatewayId,
    taplinkerId: this.taplinkerId,
    pauseDuration: this.pauseHours,
    overwrite: 'always'
  };
  this.log("%s watering plan paused (%s)", this.name,
    this.pauseHours === -1 ? "indefinite" : this.pauseHours + "h");
  this._postLinkTap("pauseWateringPlan", data, callback);
};

LinkTapAccessory.prototype._resumeWateringPlan = function(callback) {
  var self = this;

  var doResume = function(mode) {
    var endpoint = SCHEDULE_MODE_ENDPOINTS[mode];
    if (!endpoint) {
      self.log.warn("%s: could not determine the active watering mode; skipping " +
        "re-activation to avoid forcing the wrong schedule. The pause will lapse " +
        "on its own after %s.", self.name,
        self.pauseHours === -1 ? "the indefinite pause is cleared" : self.pauseHours + "h");
      if (callback) callback();
      return;
    }
    var data = {
      username: username,
      apiKey: apiKey,
      gatewayId: gatewayId,
      taplinkerId: self.taplinkerId
    };
    self.log("%s watering plan resumed (re-activating %s)", self.name, endpoint);
    self._postLinkTap(endpoint, data, callback);
  };

  if (this.platform && typeof this.platform.fetchLiveMode === 'function') {
    this.platform.fetchLiveMode(this.taplinkerId, function(err, liveMode) {
      if (err) {
        self.log.warn("%s: couldn't read live mode for resume (%s); using %s",
          self.name, err.message, self._detectedMode || self.scheduleMode);
        doResume(self._detectedMode || self.scheduleMode);
      } else {
        doResume(liveMode || self._detectedMode || self.scheduleMode);
      }
    });
  } else {
    doResume(this._detectedMode || this.scheduleMode);
  }
};

LinkTapAccessory.prototype._postLinkTap = function(endpoint, data, callback) {
  var self = this;
  var body = JSON.stringify(data);
  debug("%s body %s", endpoint, body);

  var req = https.request(_baseURL + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    var responseBody = '';
    res.on('data', function(chunk) { responseBody += chunk; });
    res.on('end', function() {
      debug('%s STATUS: %d %s', endpoint, res.statusCode, responseBody);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (callback) callback();
      } else {
        var err = new Error(endpoint + " returned HTTP " + res.statusCode + " " + responseBody);
        self.log.error(err.message);
        if (callback) callback(err);
      }
    });
  });

  req.on('error', function(error) {
    self.log.error("%s request failed: %s", endpoint, error.message);
    if (callback) callback(error);
  });

  req.write(body);
  req.end();
};

LinkTapAccessory.prototype._startTimer = function() {
  var durationInMiliseconds = this._durationInSeconds * 1000;

  this.log("Starting timer for " + durationInMiliseconds + "ms");
  this._timer = setTimeout(this._onTimeout.bind(this), durationInMiliseconds);
};

LinkTapAccessory.prototype._resetTimer = function() {
  clearTimeout(this._timer);
  this._timer = 0;
};

LinkTapAccessory.prototype._onTimeout = function() {
  this.log("Switching off the tap %s", this.name);
  this._active = 0;
  this._inUse = 0;
  this._reflectWateringState();
  this._timer = 0;
};

LinkTapAccessory.prototype._getDurationTimerValue = function(callback) {
  this.log("returning current tap duration value: " + this._durationInSeconds / 60 + " minutes");
  callback(this._durationInSeconds);
};

LinkTapAccessory.prototype._setDurationTimerValue = function(value, callback) {
  var seconds = Math.max(60, Math.min(86340, value));
  this._durationInSeconds = seconds;
  this.log("Setting the Tap duration to: " + seconds / 60 + " minutes");
  callback();
};
