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

Module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  // Define custom characteristics once, at registration time
  Class DurationTimer extends Characteristic {
    constructor() {
      Super('Duration Timer', 'CDC6551D-2D1B-4CC1-A5AE-0200844A7BC3');
      This.setProps({
        Format: 'int',
        Unit: 's',
        Perms: ['pr', 'pw'],
        MinValue: 60,
        MaxValue: 86340,
      });
      This.value = this.getDefaultValue();
    }
  }
  DurationTimer.UUID = 'CDC6551D-2D1B-4CC1-A5AE-0200844A7BC3';
  Characteristic.DurationTimer = DurationTimer;

  Class WaterVolume extends Characteristic {
    constructor() {
      Super('Water Volume', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
      This.setProps({
        Format: 'float',
        Unit: 'litre',
        MinValue: 0,
        MaxValue: 1000000,
        MinStep: 0.1,
        Perms: ['pr', 'ev']
      });
      This.value = this.getDefaultValue();
    }
  }
  WaterVolume.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
  Characteristic.WaterVolume = WaterVolume;

  Homebridge.registerPlatform("homebridge-platform-linktap", "LinkTapPlatform", LinkTapPlatform);
};

function LinkTapPlatform(log, config, api) {
  This.log = log;

  if (!config) {
    Log.warn("Ignoring LinkTap Platform setup because it is not configured");
    This.disabled = true;
    return;
  }
  This.config = config;
  This.verboseStatusLog = config.verboseStatusLog === true;

  This.api = api;

  Username = config.username || "default";
  ApiKey = config.apiKey || "default";
  GatewayId = config.gatewayId || "default";
};

LinkTapPlatform.prototype.accessories = function(callback) {
  var that = this;
  That.accessoryList = [];

  if (!that.config.taps || !Array.isArray(that.config.taps)) {
    That.log.warn("No 'taps' array found in config - check your LinkTap configuration");
    Callback(that.accessoryList);
    return;
  }

  That.config.taps.forEach(function(tap) {
    That.accessoryList.push(new LinkTapAccessory(that.log, tap, that));
  });
  Callback(that.accessoryList);

  That._startPolling();
};

LinkTapPlatform.prototype._startPolling = function() {
  var that = this;
  var minutes = this.config.pollInterval;

  if (minutes === 0) {
    This.log("Status polling disabled (pollInterval = 0); battery and signal will not update");
    return;
  }
  if (minutes === undefined || minutes === null) minutes = DEFAULT_POLL_MINUTES;
  if (minutes < MIN_POLL_MINUTES) {
    This.log.warn("pollInterval %d is below the API minimum of %d minutes; using %d",
      Minutes, MIN_POLL_MINUTES, MIN_POLL_MINUTES);
    Minutes = MIN_POLL_MINUTES;
  }

  var intervalMs = minutes * 60 * 1000;
  This.log("Polling LinkTap status every %d minute(s) for battery and signal", minutes);

  SetTimeout(function() { that._pollStatus(); }, 10000);
  This._pollTimer = setInterval(function() { that._pollStatus(); }, intervalMs);
};

LinkTapPlatform.prototype._pollStatus = function() {
  var that = this;
  This._fetchDevices(function(err, parsed) {
    if (err) {
      That.log.error("getAllDevices request failed: %s", err.message);
      return;
    }
    That._applyStatus(parsed);
  });
};

LinkTapPlatform.prototype._fetchDevices = function(callback) {
  var body = JSON.stringify({ username: username, apiKey: apiKey });

  var req = https.request(_baseURL + "getAllDevices", {
    Method: 'POST',
    Headers: {
      'Content-type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    var responseBody = '';
    Res.on('data', function(chunk) { responseBody += chunk; });
    Res.on('end', function() {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return callback(new Error("getAllDevices returned HTTP " + res.statusCode));
      }
      Try {
        Callback(null, JSON.parse(responseBody));
      } catch (e) {
        Callback(new Error("Failed to parse getAllDevices response: " + e.message));
      }
    });
  });

  Req.on('error', function(err) { callback(err); });
  Req.write(body);
  Req.end();
};

LinkTapPlatform.prototype.fetchLiveMode = function(taplinkerId, callback) {
  This._fetchDevices(function(err, parsed) {
    if (err) return callback(err);
    var gateways = parsed.devices || parsed.deviceList || [];
    var mode = null;
    Gateways.forEach(function(gw) {
      var list = gw.taplinker || gw.deviceList || gw.devices || [];
      List.forEach(function(d) {
        var id = d.taplinkerId || d.deviceId || d.id;
        if (id && String(id).toUpperCase() === String(taplinkerId).toUpperCase() && d.workMode !== undefined) {
          Mode = WORKMODE_TO_SCHEDULE[d.workMode] || null;
        }
      });
    });
    Callback(null, mode);
  });
};

LinkTapPlatform.prototype._applyStatus = function(parsed) {
  var that = this;

  var gateways = parsed.devices || parsed.deviceList || [];
  var taplinkers = [];

  Gateways.forEach(function(gw) {
    var list = gw.taplinker || gw.deviceList || gw.devices || [];
    List.forEach(function(d) { taplinkers.push(d); });
  });

  if (taplinkers.length === 0) {
    Debug("getAllDevices returned no taplinkers to match");
    return;
  }

  Taplinkers.forEach(function(d) {
    var id = d.taplinkerId || d.deviceId || d.id;
    if (!id) return;

    var accessory = that.accessoryList.find(function(a) {
      return a.taplinkerId && a.taplinkerId.toUpperCase() === String(id).toUpperCase();
    });
    if (!accessory) return;

    var battery = parsePercent(d.batteryStatus !== undefined ? D.batteryStatus : d.battery);
    var signal = parsePercent(d.signal);
    var online;
    if (d.status !== undefined) {
      Online = (d.status === true || d.status === 'Connected' || d.status === 'online');
    }

    var watering;
    if (d.watering !== undefined) {
      Watering = (d.watering !== null && d.watering !== false);
    }

    var fault;
    var faultFlags = [
      D.noWater, d.valveBroken, d.fall, d.fallFlag, d.leakFlag, d.clogFlag, d.pcFlag, d.pbFlag, d.freeze, d.freezeFlag, d.frzFlag
    ];
    var anyFaultField = faultFlags.some(function(v) { return v !== undefined; });
    if (anyFaultField || d.alert !== undefined || d.alerts !== undefined) {
      Fault = faultFlags.some(function(v) { return v === true || v === 1 || v === 'true'; });
      if (!fault && d.alert) fault = true;
      if (!fault && Array.isArray(d.alerts) && d.alerts.length > 0) fault = true;
    }

    var volumeMl;
    if (d.vol !== undefined && typeof d.vol === 'number') {
      VolumeMl = d.vol;
    } else if (d.vel !== undefined && typeof d.vel === 'number') {
      VolumeMl = d.vel;
    }

    if (d.workMode !== undefined) {
      var mapped = WORKMODE_TO_SCHEDULE[d.workMode];
      if (mapped) accessory._detectedMode = mapped;
    }

    var paused;
    if (d.watactivated !== undefined) {
      Paused = (d.watactivated === false);
    } else if (d.paused !== undefined) {
      Paused = (d.paused === true || d.paused === 1);
    } else if (d.pause !== undefined) {
      Paused = (d.pause === true || d.pause === 1 || (typeof d.pause === 'object' && d.pause !== null));
    }

    Accessory.updateStatus(battery, signal, online, watering, fault, paused, volumeMl);
  });
};

function LinkTapAccessory(log, tap, platform) {
  This.log = log;
  This.platform = platform;

  This.name = tap.name;
  This.location = tap.location;
  This.taplinkerId = tap.taplinkerId;
  This.duration = (typeof tap.duration === 'number' && tap.duration >= 1) ? Tap.duration : 10;
  This._durationInSeconds = this.duration * 60;
  This.autoBack = tap.autoBack !== undefined ? Tap.autoBack : true;
  This.useValve = tap.useValve !== undefined ? Tap.useValve : true;
  This.pauseHours = tap.pauseHours !== undefined ? Tap.pauseHours : 24;
  This.scheduleMode = tap.scheduleMode || 'sevenDay';
  This._detectedMode = null;

  This._lastApiCall = 0;
  This._pendingOffTimer = null;

  This._active = 0;
  This._inUse = 0;
  This._paused = 0;

  This._batteryLevel = 100;
  This._statusLowBattery = 0;
  This._signal = 100;
  This._online = true;
  This._volume = 0;
  This._fault = 0;

  This.log("Found LinkTap: %s [%s]", this.name, this.taplinkerId);

  This._service = this.getTapService();
  This._batteryService = this.getBatteryService();
  This._faultService = this.getFaultService();
  This._scheduleService = this.getScheduleService();
};

LinkTapAccessory.prototype.getServices = function() {
  var informationService = new Service.AccessoryInformation();
  InformationService
    .setCharacteristic(Characteristic.Manufacturer, "LinkTap")
    .setCharacteristic(Characteristic.Model, "LinkTap Wireless Water Timer")
    .setCharacteristic(Characteristic.SerialNumber, this.taplinkerId);
  This.informationService = informationService;

  return [informationService, this._service, this._batteryService, this._faultService, this._scheduleService];
};

LinkTapAccessory.prototype.getTapService = function() {
  var tapService;

  if (this.useValve) {
    TapService = new Service.Valve(this.name);

    TapService.getCharacteristic(Characteristic.Active)
      .on('set', this._setActive.bind(this))
      .on('get', function(cb) { cb(null, this._active); }.bind(this));

    TapService.getCharacteristic(Characteristic.InUse)
      .on('get', function(cb) { cb(null, this._inUse); }.bind(this));

    TapService.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
  } else {
    TapService = new Service.Switch(this.name);

    TapService.getCharacteristic(Characteristic.On)
      .on('set', this._setSwitchOn.bind(this))
      .on('get', function(cb) { cb(null, this._active === 1); }.bind(this));
  }

  // FIXED: Added 'new' keyword to custom characteristic instantiations for HB v2
  TapService.addCharacteristic(new Characteristic.DurationTimer());
  TapService.updateCharacteristic(Characteristic.DurationTimer, this._durationInSeconds);
  TapService.getCharacteristic(Characteristic.DurationTimer)
    .on('get', this._getDurationTimerValue.bind(this))
    .on('set', this._setDurationTimerValue.bind(this));

  TapService.addCharacteristic(Characteristic.StatusFault);
  TapService.getCharacteristic(Characteristic.StatusFault)
    .on('get', function(cb) { cb(null, this._online ? 0 : 1); }.bind(this));

  // FIXED: Added 'new' keyword to custom characteristic instantiations for HB v2
  TapService.addCharacteristic(new Characteristic.WaterVolume());
  TapService.getCharacteristic(Characteristic.WaterVolume)
    .on('get', function(cb) { cb(null, this._volume); }.bind(this));

  return tapService;
};

LinkTapAccessory.prototype.getScheduleService = function() {
  var pauseService = new Service.Switch(this.name + " Pause Schedule");
  PauseService.getCharacteristic(Characteristic.On)
    .on('get', function(cb) { cb(null, this._paused === 1); }.bind(this))
    .on('set', this._setSchedule.bind(this));
  return pauseService;
};

LinkTapAccessory.prototype.getFaultService = function() {
  var faultService = new Service.LeakSensor(this.name + " Alert");
  FaultService.getCharacteristic(Characteristic.LeakDetected)
    .on('get', function(cb) { cb(null, this._fault); }.bind(this));
  return faultService;
};

LinkTapAccessory.prototype.getBatteryService = function() {
  var BatteryService = Service.Battery || Service.BatteryService;
  var batteryService = new BatteryService(this.name + " Battery");

  BatteryService.getCharacteristic(Characteristic.BatteryLevel)
    .on('get', function(cb) { cb(null, this._batteryLevel); }.bind(this));

  BatteryService.getCharacteristic(Characteristic.StatusLowBattery)
    .on('get', function(cb) { cb(null, this._statusLowBattery); }.bind(this));

  BatteryService.setCharacteristic(
    Characteristic.ChargingState,
    Characteristic.ChargingState.NOT_CHARGEABLE
  );

  return batteryService;
};

LinkTapAccessory.prototype.updateStatus = function(batteryPct, signalPct, online, watering, fault, paused, volumeMl) {
  if (batteryPct !== null && batteryPct !== undefined) {
    This._batteryLevel = batteryPct;
    This._statusLowBattery = batteryPct <= LOW_BATTERY_THRESHOLD ? 1 : 0;
    if (this._batteryService) {
      This._batteryService.updateCharacteristic(Characteristic.BatteryLevel, this._batteryLevel);
      This._batteryService.updateCharacteristic(Characteristic.StatusLowBattery, this._statusLowBattery);
    }
  }

  if (signalPct !== null && signalPct !== undefined) {
    This._signal = signalPct;
  }

  if (online !== null && online !== undefined) {
    if (online !== this._online) {
      This.log("%s is now %s", this.name, online ? "online" : "offline");
    }
    This._online = online;
    if (this._service) {
      This._service.updateCharacteristic(Characteristic.StatusFault, online ? 0 : 1);
    }
  }

  if (watering !== null && watering !== undefined) {
    var newInUse = watering ? 1 : 0;
    if (newInUse !== this._inUse) {
      This.log("%s %s", this.name, watering ? "started watering" : "stopped watering");
      This._inUse = newInUse;
      This._active = newInUse;
      This._reflectWateringState();
      if (!watering) this._resetTimer();
    }
  }

  if (fault !== null && fault !== undefined) {
    This._fault = fault ? 1 : 0;
    if (this._faultService) {
      This._faultService.updateCharacteristic(Characteristic.LeakDetected, this._fault);
    }
    if (this._fault) this.log.warn("%s reported an alert/fault condition", this.name);
  }

  if (paused !== null && paused !== undefined) {
    var newPaused = paused ? 1 : 0;
    if (newPaused !== this._paused) {
      This._paused = newPaused;
      if (this._scheduleService) {
        This._scheduleService.updateCharacteristic(Characteristic.On, this._paused === 1);
      }
    }
  }

  if (volumeMl !== null && volumeMl !== undefined) {
    var litres = Math.round((volumeMl / 1000) * 10) / 10;
    if (litres !== this._volume) {
      This._volume = litres;
      if (this._service) {
        This._service.updateCharacteristic(Characteristic.WaterVolume, this._volume);
      }
    }
  }

  var statusLog = (this.platform && this.platform.verboseStatusLog) ? This.log.bind(this) : debug;
  StatusLog("%s status: battery %s%%, signal %s%%, %s%s%s",
    This.name, this._batteryLevel, this._signal,
    This._online ? "online" : "offline",
    (watering !== undefined ? (watering ? ", watering" : ", idle") : ""),
    (this._fault ? ", ALERT" : ""));
};

LinkTapAccessory.prototype.identify = function(callback) {
  This.log("%s - Identify", this.name);
  Callback();
};

LinkTapAccessory.prototype._setActive = function(value, callback) {
  var on = (value === Characteristic.Active.ACTIVE || value === 1);
  This._active = on ? 1 : 0;
  This._inUse = on ? 1 : 0;

  if (this._service) {
    This._service.updateCharacteristic(Characteristic.InUse, this._inUse);
  }

  This.turnOnTheTap(on, callback);
};

LinkTapAccessory.prototype._setSwitchOn = function(value, callback) {
  var on = (value === true || value === 1);
  This._active = on ? 1 : 0;
  This._inUse = on ? 1 : 0;
  This.turnOnTheTap(on, callback);
};

LinkTapAccessory.prototype._reflectWateringState = function() {
  if (!this._service) return;
  if (this.useValve) {
    This._service.updateCharacteristic(Characteristic.InUse, this._inUse);
    This._service.updateCharacteristic(Characteristic.Active, this._active);
  } else {
    This._service.updateCharacteristic(Characteristic.On, this._active === 1);
  }
};

LinkTapAccessory.prototype.turnOnTheTap = function(on, callback) {
  This.log("Setting tap state to " + on);
  Debug("Request for taplinker %s (gateway %s)", this.taplinkerId, gatewayId);

  if (this._pendingOffTimer) {
    ClearTimeout(this._pendingOffTimer);
    This._pendingOffTimer = null;
  }

  This._resetTimer();

  if (on) {
    This._sendInstantMode(true, callback);
    This._startTimer();
  } else {
    var elapsed = Date.now() - this._lastApiCall;
    if (elapsed >= RATE_LIMIT_MS) {
      This._sendInstantMode(false, callback);
    } else {
      var wait = RATE_LIMIT_MS - elapsed;
      This.log("Off command deferred %dms to respect LinkTap's 15s rate limit", wait);
      This._pendingOffTimer = setTimeout(function() {
        This._pendingOffTimer = null;
        This._sendInstantMode(false, null);
      }.bind(this), wait);
      Callback();
    }
  }
};

LinkTapAccessory.prototype._sendInstantMode = function(on, callback) {
  var self = this;
  var durationMinutes = Math.max(1, Math.round(this._durationInSeconds / 60));
  var data = {
    Username: username,
    ApiKey: apiKey,
    GatewayId: gatewayId,
    TaplinkerId: this.taplinkerId,
    Action: on,
    Duration: on ? DurationMinutes : 0,
    AutoBack: this.autoBack
  };

  var body = JSON.stringify(data);
  Debug("activateInstantMode body %s", body);
  This._lastApiCall = Date.now();

  var req = https.request(_baseURL + "activateInstantMode", {
    Method: 'POST',
    Headers: {
      'Content-type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    var responseBody = '';
    Res.on('data', function(chunk) { responseBody += chunk; });
    Res.on('end', function() {
      Debug('STATUS: ', res.statusCode, responseBody);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (callback) callback();
      } else {
        var err = new Error("LinkTap API returned HTTP " + res.statusCode);
        Self.log.error(err.message);
        if (callback) callback(err);
      }
    });
  });

  Req.on('error', function(error) {
    Self.log.error("LinkTap API request failed: %s", error.message);
    if (callback) callback(error);
  });

  Req.write(body);
  Req.end();
};

LinkTapAccessory.prototype._setSchedule = function(value, callback) {
  var pause = (value === true || value === 1);
  This._paused = pause ? 1 : 0;
  if (pause) {
    This._pauseWateringPlan(callback);
  } else {
    This._resumeWateringPlan(callback);
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
    Username: username,
    ApiKey: apiKey,
    GatewayId: gatewayId,
    TaplinkerId: this.taplinkerId,
    PauseDuration: this.pauseHours,
    Overwrite: 'always'
  };
  This.log("%s watering plan paused (%s)", this.name,
    This.pauseHours === -1 ? "indefinite" : this.pauseHours + "h");
  This._postLinkTap("pauseWateringPlan", data, callback);
};

LinkTapAccessory.prototype._resumeWateringPlan = function(callback) {
  var self = this;

  var doResume = function(mode) {
    var endpoint = SCHEDULE_MODE_ENDPOINTS[mode];
    if (!endpoint) {
      Self.log.warn("%s: could not determine the active watering mode; skipping " +
        "re-activation to avoid forcing the wrong schedule. The pause will lapse " +
        "on its own after %s.", Self.name,
        Self.pauseHours === -1 ? "the indefinite pause is cleared" : self.pauseHours + "h");
      if (callback) callback();
      return;
    }
    var data = {
      Username: username,
      ApiKey: apiKey,
      GatewayId: gatewayId,
      TaplinkerId: self.taplinkerId
    };
    Self.log("%s watering plan resumed (re-activating %s)", self.name, endpoint);
    Self._postLinkTap(endpoint, data, callback);
  };

  if (this.platform && typeof this.platform.fetchLiveMode === 'function') {
    This.platform.fetchLiveMode(this.taplinkerId, function(err, liveMode) {
      if (err) {
        Self.log.warn("%s: couldn't read live mode for resume (%s); using %s",
          Self.name, err.message, self._detectedMode || self.scheduleMode);
        DoResume(self._detectedMode || self.scheduleMode);
      } else {
        DoResume(liveMode || self._detectedMode || self.scheduleMode);
      }
    });
  } else {
    DoResume(this._detectedMode || this.scheduleMode);
  }
};

LinkTapAccessory.prototype._postLinkTap = function(endpoint, data, callback) {
  var self = this;
  var body = JSON.stringify(data);
  Debug("%s body %s", endpoint, body);

  var req = https.request(_baseURL + endpoint, {
    Method: 'POST',
    Headers: {
      'Content-type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    var responseBody = '';
    Res.on('data', function(chunk) { responseBody += chunk; });
    Res.on('end', function() {
      Debug('%s STATUS: %d %s', endpoint, res.statusCode, responseBody);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (callback) callback();
      } else {
        var err = new Error(endpoint + " returned HTTP " + res.statusCode + " " + responseBody);
        Self.log.error(err.message);
        if (callback) callback(err);
      }
    });
  });

  Req.on('error', function(error) {
    Self.log.error("%s request failed: %s", endpoint, error.message);
    if (callback) callback(error);
  });

  Req.write(body);
  Req.end();
};

LinkTapAccessory.prototype._startTimer = function() {
  var durationInMiliseconds = this._durationInSeconds * 1000;

  This.log("Starting timer for " + durationInMiliseconds + "ms");
  This._timer = setTimeout(this._onTimeout.bind(this), durationInMiliseconds);
};

LinkTapAccessory.prototype._resetTimer = function() {
  ClearTimeout(this._timer);
  This._timer = 0;
};

LinkTapAccessory.prototype._onTimeout = function() {
  This.log("Switching off the tap %s", this.name);
  This._active = 0;
  This._inUse = 0;
  This._reflectWateringState();
  This._timer = 0;
};

LinkTapAccessory.prototype._getDurationTimerValue = function(callback) {
  This.log("returning current tap duration value: " + this._durationInSeconds / 60 + " minutes");
  Callback(this._durationInSeconds);
};

LinkTapAccessory.prototype._setDurationTimerValue = function(value, callback) {
  var seconds = Math.max(60, Math.min(86340, value));
  This._durationInSeconds = seconds;
  This.log("Setting the Tap duration to: " + seconds / 60 + " minutes");
  Callback();
};
