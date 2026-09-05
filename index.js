Const https = require('https');
Const _baseURL = 'https://www.link-tap.com/api/';
Const RATE_LIMIT_MS = 15000;        // activateInstantMode: min 15s between calls
Const MIN_POLL_MINUTES = 5;         // getAllDevices: manufacturer limits status polling to every 5 min
Const DEFAULT_POLL_MINUTES = 15;    // default refresh; raise/lower via pollInterval. 5 = API minimum
Const LOW_BATTERY_THRESHOLD = 20;   // percent at or below which HomeKit shows a low-battery warning
Var Service, Characteristic;
Var debug = require('debug')('linktap');

Var username, apiKey, gatewayId;

// Parse a battery/signal value that may arrive as a number (85) or a string ("85%")
Function parsePercent(val) {
  If (val === null || val === undefined) return null;
  If (typeof val === 'number') return Math.max(0, Math.min(100, Math.round(val)));
  Var m = String(val).match(/(\d+(\.\d+)?)/);
  Return m ? Math.max(0, Math.min(100, Math.round(parseFloat(m[1])))) : null;
}

Module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  // Define custom characteristics once, at registration time
  Class DurationTimer extends Characteristic {
    Constructor() {
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
    Constructor() {
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

Function LinkTapPlatform(log, config, api) {
  This.log = log;

  If (!config) {
    Log.warn("Ignoring LinkTap Platform setup because it is not configured");
    This.disabled = true;
    Return;
  }
  This.config = config;
  This.verboseStatusLog = config.verboseStatusLog === true;

  This.api = api;

  Username = config.username || "default";
  ApiKey = config.apiKey || "default";
  GatewayId = config.gatewayId || "default";
};

LinkTapPlatform.prototype.accessories = function(callback) {
  Var that = this;
  That.accessoryList = [];

  If (!that.config.taps || !Array.isArray(that.config.taps)) {
    That.log.warn("No 'taps' array found in config - check your LinkTap configuration");
    Callback(that.accessoryList);
    Return;
  }

  That.config.taps.forEach(function(tap) {
    That.accessoryList.push(new LinkTapAccessory(that.log, tap, that));
  });
  Callback(that.accessoryList);

  That._startPolling();
};

LinkTapPlatform.prototype._startPolling = function() {
  Var that = this;
  Var minutes = this.config.pollInterval;

  If (minutes === 0) {
    This.log("Status polling disabled (pollInterval = 0); battery and signal will not update");
    Return;
  }
  If (minutes === undefined || minutes === null) minutes = DEFAULT_POLL_MINUTES;
  If (minutes < MIN_POLL_MINUTES) {
    This.log.warn("pollInterval %d is below the API minimum of %d minutes; using %d",
      Minutes, MIN_POLL_MINUTES, MIN_POLL_MINUTES);
    Minutes = MIN_POLL_MINUTES;
  }

  Var intervalMs = minutes * 60 * 1000;
  This.log("Polling LinkTap status every %d minute(s) for battery and signal", minutes);

  SetTimeout(function() { that._pollStatus(); }, 10000);
  This._pollTimer = setInterval(function() { that._pollStatus(); }, intervalMs);
};

LinkTapPlatform.prototype._pollStatus = function() {
  Var that = this;
  This._fetchDevices(function(err, parsed) {
    If (err) {
      That.log.error("getAllDevices request failed: %s", err.message);
      Return;
    }
    That._applyStatus(parsed);
  });
};

LinkTapPlatform.prototype._fetchDevices = function(callback) {
  Var body = JSON.stringify({ username: username, apiKey: apiKey });

  Var req = https.request(_baseURL + "getAllDevices", {
    Method: 'POST',
    Headers: {
      'Content-type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    Var responseBody = '';
    Res.on('data', function(chunk) { responseBody += chunk; });
    Res.on('end', function() {
      If (res.statusCode < 200 || res.statusCode >= 300) {
        Return callback(new Error("getAllDevices returned HTTP " + res.statusCode));
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
    If (err) return callback(err);
    Var gateways = parsed.devices || parsed.deviceList || [];
    Var mode = null;
    Gateways.forEach(function(gw) {
      Var list = gw.taplinker || gw.deviceList || gw.devices || [];
      List.forEach(function(d) {
        Var id = d.taplinkerId || d.deviceId || d.id;
        If (id && String(id).toUpperCase() === String(taplinkerId).toUpperCase() && d.workMode !== undefined) {
          Mode = WORKMODE_TO_SCHEDULE[d.workMode] || null;
        }
      });
    });
    Callback(null, mode);
  });
};

LinkTapPlatform.prototype._applyStatus = function(parsed) {
  Var that = this;

  Var gateways = parsed.devices || parsed.deviceList || [];
  Var taplinkers = [];

  Gateways.forEach(function(gw) {
    Var list = gw.taplinker || gw.deviceList || gw.devices || [];
    List.forEach(function(d) { taplinkers.push(d); });
  });

  If (taplinkers.length === 0) {
    Debug("getAllDevices returned no taplinkers to match");
    Return;
  }

  Taplinkers.forEach(function(d) {
    Var id = d.taplinkerId || d.deviceId || d.id;
    If (!id) return;

    Var accessory = that.accessoryList.find(function(a) {
      Return a.taplinkerId && a.taplinkerId.toUpperCase() === String(id).toUpperCase();
    });
    If (!accessory) return;

    Var battery = parsePercent(d.batteryStatus !== undefined ? D.batteryStatus : d.battery);
    Var signal = parsePercent(d.signal);
    Var online;
    If (d.status !== undefined) {
      Online = (d.status === true || d.status === 'Connected' || d.status === 'online');
    }

    Var watering;
    If (d.watering !== undefined) {
      Watering = (d.watering !== null && d.watering !== false);
    }

    Var fault;
    Var faultFlags = [
      D.noWater, d.valveBroken, d.fall, d.fallFlag, d.leakFlag, d.clogFlag, d.pcFlag, d.pbFlag, d.freeze, d.freezeFlag, d.frzFlag
    ];
    Var anyFaultField = faultFlags.some(function(v) { return v !== undefined; });
    If (anyFaultField || d.alert !== undefined || d.alerts !== undefined) {
      Fault = faultFlags.some(function(v) { return v === true || v === 1 || v === 'true'; });
      If (!fault && d.alert) fault = true;
      If (!fault && Array.isArray(d.alerts) && d.alerts.length > 0) fault = true;
    }

    Var volumeMl;
    If (d.vol !== undefined && typeof d.vol === 'number') {
      VolumeMl = d.vol;
    } else if (d.vel !== undefined && typeof d.vel === 'number') {
      VolumeMl = d.vel;
    }

    If (d.workMode !== undefined) {
      Var mapped = WORKMODE_TO_SCHEDULE[d.workMode];
      If (mapped) accessory._detectedMode = mapped;
    }

    Var paused;
    If (d.watactivated !== undefined) {
      Paused = (d.watactivated === false);
    } else if (d.paused !== undefined) {
      Paused = (d.paused === true || d.paused === 1);
    } else if (d.pause !== undefined) {
      Paused = (d.pause === true || d.pause === 1 || (typeof d.pause === 'object' && d.pause !== null));
    }

    Accessory.updateStatus(battery, signal, online, watering, fault, paused, volumeMl);
  });
};

Function LinkTapAccessory(log, tap, platform) {
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
  Var informationService = new Service.AccessoryInformation();
  InformationService
    .setCharacteristic(Characteristic.Manufacturer, "LinkTap")
    .setCharacteristic(Characteristic.Model, "LinkTap Wireless Water Timer")
    .setCharacteristic(Characteristic.SerialNumber, this.taplinkerId);
  This.informationService = informationService;

  Return [informationService, this._service, this._batteryService, this._faultService, this._scheduleService];
};

LinkTapAccessory.prototype.getTapService = function() {
  Var tapService;

  If (this.useValve) {
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

  Return tapService;
};

LinkTapAccessory.prototype.getScheduleService = function() {
  Var pauseService = new Service.Switch(this.name + " Pause Schedule");
  PauseService.getCharacteristic(Characteristic.On)
    .on('get', function(cb) { cb(null, this._paused === 1); }.bind(this))
    .on('set', this._setSchedule.bind(this));
  Return pauseService;
};

LinkTapAccessory.prototype.getFaultService = function() {
  Var faultService = new Service.LeakSensor(this.name + " Alert");
  FaultService.getCharacteristic(Characteristic.LeakDetected)
    .on('get', function(cb) { cb(null, this._fault); }.bind(this));
  Return faultService;
};

LinkTapAccessory.prototype.getBatteryService = function() {
  Var BatteryService = Service.Battery || Service.BatteryService;
  Var batteryService = new BatteryService(this.name + " Battery");

  BatteryService.getCharacteristic(Characteristic.BatteryLevel)
    .on('get', function(cb) { cb(null, this._batteryLevel); }.bind(this));

  BatteryService.getCharacteristic(Characteristic.StatusLowBattery)
    .on('get', function(cb) { cb(null, this._statusLowBattery); }.bind(this));

  BatteryService.setCharacteristic(
    Characteristic.ChargingState,
    Characteristic.ChargingState.NOT_CHARGEABLE
  );

  Return batteryService;
};

LinkTapAccessory.prototype.updateStatus = function(batteryPct, signalPct, online, watering, fault, paused, volumeMl) {
  If (batteryPct !== null && batteryPct !== undefined) {
    This._batteryLevel = batteryPct;
    This._statusLowBattery = batteryPct <= LOW_BATTERY_THRESHOLD ? 1 : 0;
    If (this._batteryService) {
      This._batteryService.updateCharacteristic(Characteristic.BatteryLevel, this._batteryLevel);
      This._batteryService.updateCharacteristic(Characteristic.StatusLowBattery, this._statusLowBattery);
    }
  }

  If (signalPct !== null && signalPct !== undefined) {
    This._signal = signalPct;
  }

  If (online !== null && online !== undefined) {
    If (online !== this._online) {
      This.log("%s is now %s", this.name, online ? "online" : "offline");
    }
    This._online = online;
    If (this._service) {
      This._service.updateCharacteristic(Characteristic.StatusFault, online ? 0 : 1);
    }
  }

  If (watering !== null && watering !== undefined) {
    Var newInUse = watering ? 1 : 0;
    If (newInUse !== this._inUse) {
      This.log("%s %s", this.name, watering ? "started watering" : "stopped watering");
      This._inUse = newInUse;
      This._active = newInUse;
      This._reflectWateringState();
      If (!watering) this._resetTimer();
    }
  }

  If (fault !== null && fault !== undefined) {
    This._fault = fault ? 1 : 0;
    If (this._faultService) {
      This._faultService.updateCharacteristic(Characteristic.LeakDetected, this._fault);
    }
    If (this._fault) this.log.warn("%s reported an alert/fault condition", this.name);
  }

  If (paused !== null && paused !== undefined) {
    Var newPaused = paused ? 1 : 0;
    If (newPaused !== this._paused) {
      This._paused = newPaused;
      If (this._scheduleService) {
        This._scheduleService.updateCharacteristic(Characteristic.On, this._paused === 1);
      }
    }
  }

  If (volumeMl !== null && volumeMl !== undefined) {
    Var litres = Math.round((volumeMl / 1000) * 10) / 10;
    If (litres !== this._volume) {
      This._volume = litres;
      If (this._service) {
        This._service.updateCharacteristic(Characteristic.WaterVolume, this._volume);
      }
    }
  }

  Var statusLog = (this.platform && this.platform.verboseStatusLog) ? This.log.bind(this) : debug;
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
  Var on = (value === Characteristic.Active.ACTIVE || value === 1);
  This._active = on ? 1 : 0;
  This._inUse = on ? 1 : 0;

  If (this._service) {
    This._service.updateCharacteristic(Characteristic.InUse, this._inUse);
  }

  This.turnOnTheTap(on, callback);
};

LinkTapAccessory.prototype._setSwitchOn = function(value, callback) {
  Var on = (value === true || value === 1);
  This._active = on ? 1 : 0;
  This._inUse = on ? 1 : 0;
  This.turnOnTheTap(on, callback);
};

LinkTapAccessory.prototype._reflectWateringState = function() {
  If (!this._service) return;
  If (this.useValve) {
    This._service.updateCharacteristic(Characteristic.InUse, this._inUse);
    This._service.updateCharacteristic(Characteristic.Active, this._active);
  } else {
    This._service.updateCharacteristic(Characteristic.On, this._active === 1);
  }
};

LinkTapAccessory.prototype.turnOnTheTap = function(on, callback) {
  This.log("Setting tap state to " + on);
  Debug("Request for taplinker %s (gateway %s)", this.taplinkerId, gatewayId);

  If (this._pendingOffTimer) {
    ClearTimeout(this._pendingOffTimer);
    This._pendingOffTimer = null;
  }

  This._resetTimer();

  If (on) {
    This._sendInstantMode(true, callback);
    This._startTimer();
  } else {
    Var elapsed = Date.now() - this._lastApiCall;
    If (elapsed >= RATE_LIMIT_MS) {
      This._sendInstantMode(false, callback);
    } else {
      Var wait = RATE_LIMIT_MS - elapsed;
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
  Var self = this;
  Var durationMinutes = Math.max(1, Math.round(this._durationInSeconds / 60));
  Var data = {
    Username: username,
    ApiKey: apiKey,
    GatewayId: gatewayId,
    TaplinkerId: this.taplinkerId,
    Action: on,
    Duration: on ? DurationMinutes : 0,
    AutoBack: this.autoBack
  };

  Var body = JSON.stringify(data);
  Debug("activateInstantMode body %s", body);
  This._lastApiCall = Date.now();

  Var req = https.request(_baseURL + "activateInstantMode", {
    Method: 'POST',
    Headers: {
      'Content-type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    Var responseBody = '';
    Res.on('data', function(chunk) { responseBody += chunk; });
    Res.on('end', function() {
      Debug('STATUS: ', res.statusCode, responseBody);
      If (res.statusCode >= 200 && res.statusCode < 300) {
        If (callback) callback();
      } else {
        Var err = new Error("LinkTap API returned HTTP " + res.statusCode);
        Self.log.error(err.message);
        If (callback) callback(err);
      }
    });
  });

  Req.on('error', function(error) {
    Self.log.error("LinkTap API request failed: %s", error.message);
    If (callback) callback(error);
  });

  Req.write(body);
  Req.end();
};

LinkTapAccessory.prototype._setSchedule = function(value, callback) {
  Var pause = (value === true || value === 1);
  This._paused = pause ? 1 : 0;
  If (pause) {
    This._pauseWateringPlan(callback);
  } else {
    This._resumeWateringPlan(callback);
  }
};

Var SCHEDULE_MODE_ENDPOINTS = {
  SevenDay: 'activateSevenDayMode',
  Interval: 'activateIntervalMode',
  OddEven: 'activateOddEvenMode',
  Month: 'activateMonthMode',
  Calendar: 'activateCalendarMode'
};

Var WORKMODE_TO_SCHEDULE = {
  'I': 'interval',
  'T': 'sevenDay',
  'O': 'oddEven',
  'D': 'calendar',
  'Y': 'month'
};

LinkTapAccessory.prototype._pauseWateringPlan = function(callback) {
  Var data = {
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
  Var self = this;

  Var doResume = function(mode) {
    Var endpoint = SCHEDULE_MODE_ENDPOINTS[mode];
    If (!endpoint) {
      Self.log.warn("%s: could not determine the active watering mode; skipping " +
        "re-activation to avoid forcing the wrong schedule. The pause will lapse " +
        "on its own after %s.", Self.name,
        Self.pauseHours === -1 ? "the indefinite pause is cleared" : self.pauseHours + "h");
      If (callback) callback();
      Return;
    }
    Var data = {
      Username: username,
      ApiKey: apiKey,
      GatewayId: gatewayId,
      TaplinkerId: self.taplinkerId
    };
    Self.log("%s watering plan resumed (re-activating %s)", self.name, endpoint);
    Self._postLinkTap(endpoint, data, callback);
  };

  If (this.platform && typeof this.platform.fetchLiveMode === 'function') {
    This.platform.fetchLiveMode(this.taplinkerId, function(err, liveMode) {
      If (err) {
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
  Var self = this;
  Var body = JSON.stringify(data);
  Debug("%s body %s", endpoint, body);

  Var req = https.request(_baseURL + endpoint, {
    Method: 'POST',
    Headers: {
      'Content-type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function(res) {
    Var responseBody = '';
    Res.on('data', function(chunk) { responseBody += chunk; });
    Res.on('end', function() {
      Debug('%s STATUS: %d %s', endpoint, res.statusCode, responseBody);
      If (res.statusCode >= 200 && res.statusCode < 300) {
        If (callback) callback();
      } else {
        Var err = new Error(endpoint + " returned HTTP " + res.statusCode + " " + responseBody);
        Self.log.error(err.message);
        If (callback) callback(err);
      }
    });
  });

  Req.on('error', function(error) {
    Self.log.error("%s request failed: %s", endpoint, error.message);
    If (callback) callback(error);
  });

  Req.write(body);
  Req.end();
};

LinkTapAccessory.prototype._startTimer = function() {
  Var durationInMiliseconds = this._durationInSeconds * 1000;

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
  This.log("Returning current tap duration value: " + this._durationInSeconds / 60 + " minutes");
  Callback(this._durationInSeconds);
};

LinkTapAccessory.prototype._setDurationTimerValue = function(value, callback) {
  Var seconds = Math.max(60, Math.min(86340, value));
  This._durationInSeconds = seconds;
  This.log("Setting the Tap duration to: " + seconds / 60 + " minutes");
  Callback();
};
