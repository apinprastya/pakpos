// Pakpos script prelude: builds pm, console and the sandbox globals for one
// script run. The program's value is a function Go calls with the host
// functions, the input (as JSON) and the expect library; it returns
// finish(), which reports the run's state (as JSON) back to Go. The host
// object stays in this closure, so scripts can't reach it.
(function (host, inputJSON, lib) {
  "use strict";

  var input = JSON.parse(inputJSON);
  var expect = lib.expect;
  var g = globalThis;
  var state = { request: input.request, nextRequest: null, nextRequestSet: false, skip: false };

  function str(v) {
    if (v === undefined) return "";
    if (typeof v === "string") return v;
    if (v !== null && typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function lc(s) {
    return String(s).toLowerCase();
  }

  function fail(message) {
    throw new Error(message);
  }

  // ---- variables ----

  function scope(kind, label) {
    var setKind = kind === "" ? "local" : kind;
    return {
      get: function (key) {
        return host.varGet(kind, str(key));
      },
      has: function (key) {
        return host.varGet(kind, str(key)) !== undefined;
      },
      set: function (key, value) {
        if (arguments.length < 1 || str(key).trim() === "") fail(label + ".set needs a variable name");
        host.varSet(setKind, str(key), str(value));
      },
      unset: function (key) {
        host.varUnset(setKind, str(key));
      },
      toObject: function () {
        return JSON.parse(host.varAll(kind));
      },
      replaceIn: function (text) {
        return host.replaceIn(str(text));
      },
    };
  }

  var environment = scope("environment", "pm.environment");
  environment.name = input.environmentName;

  // ---- request ----

  var req = state.request;
  var mutable = input.event === "prerequest";

  function guard() {
    if (!mutable) fail("pm.request can only be changed in a pre-request script");
  }

  function toHeader(h, value) {
    if (typeof h === "string" && value !== undefined) return { key: h, value: str(value) };
    if (typeof h === "string") {
      var i = h.indexOf(":");
      return i < 0 ? { key: h.trim(), value: "" } : { key: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
    }
    if (h === null || typeof h !== "object") fail("A header needs a key and a value, like {key: 'X-Id', value: '1'}");
    return { key: str(h.key), value: str(h.value) };
  }

  function enabledHeaders() {
    return req.headers.filter(function (h) {
      return h.enabled && h.key.trim() !== "";
    });
  }

  function headerList(rows) {
    return {
      get: function (name) {
        var n = lc(name), v;
        rows().forEach(function (h) {
          if (lc(h.key) === n) v = h.value;
        });
        return v;
      },
      has: function (name, value) {
        var n = lc(name);
        return rows().some(function (h) {
          return lc(h.key) === n && (value === undefined || h.value === str(value));
        });
      },
      each: function (fn) {
        rows().forEach(function (h) {
          fn({ key: h.key, value: h.value });
        });
      },
      all: function () {
        return rows().map(function (h) {
          return { key: h.key, value: h.value };
        });
      },
      count: function () {
        return rows().length;
      },
      toObject: function () {
        var o = {};
        rows().forEach(function (h) {
          o[h.key] = h.value;
        });
        return o;
      },
    };
  }

  var reqHeaders = headerList(enabledHeaders);
  reqHeaders.add = function (h, value) {
    guard();
    var row = toHeader(h, value);
    req.headers.push({ key: row.key, value: row.value, enabled: true });
  };
  reqHeaders.upsert = function (h, value) {
    guard();
    var row = toHeader(h, value), n = lc(row.key), done = false;
    req.headers = req.headers.filter(function (x) {
      if (!x.enabled || lc(x.key) !== n) return true;
      if (done) return false;
      x.value = row.value;
      done = true;
      return true;
    });
    if (!done) req.headers.push({ key: row.key, value: row.value, enabled: true });
  };
  reqHeaders.remove = function (name) {
    guard();
    var n = lc(typeof name === "object" && name !== null ? name.key : name);
    req.headers = req.headers.filter(function (x) {
      return lc(x.key) !== n;
    });
  };

  function splitURL(u) {
    var hash = "", i = u.indexOf("#");
    if (i >= 0) {
      hash = u.slice(i);
      u = u.slice(0, i);
    }
    var q = "";
    i = u.indexOf("?");
    if (i >= 0) {
      q = u.slice(i + 1);
      u = u.slice(0, i);
    }
    return { base: u, query: q, hash: hash };
  }

  function decode(s) {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch (e) {
      return s;
    }
  }

  function queryPairs(params) {
    if (typeof params === "string") return params.split("&").filter(Boolean);
    if (!Array.isArray(params)) params = [params];
    return params.map(function (p) {
      if (typeof p === "string") return p;
      return encodeURIComponent(str(p.key)) + (p.value === undefined || p.value === null ? "" : "=" + encodeURIComponent(str(p.value)));
    });
  }

  var url = {
    toString: function () {
      return req.url;
    },
    toJSON: function () {
      return req.url;
    },
    valueOf: function () {
      return req.url;
    },
    getQueryString: function () {
      return splitURL(req.url).query;
    },
    addQueryParams: function (params) {
      guard();
      var p = splitURL(req.url);
      var pairs = (p.query ? p.query.split("&") : []).concat(queryPairs(params));
      req.url = p.base + (pairs.length ? "?" + pairs.join("&") : "") + p.hash;
    },
    removeQueryParams: function (names) {
      guard();
      var list = (Array.isArray(names) ? names : [names]).map(function (n) {
        return typeof n === "object" && n !== null ? str(n.key) : str(n);
      });
      var p = splitURL(req.url);
      var pairs = (p.query ? p.query.split("&") : []).filter(function (pair) {
        return list.indexOf(decode(pair.split("=")[0])) < 0;
      });
      req.url = p.base + (pairs.length ? "?" + pairs.join("&") : "") + p.hash;
    },
  };

  var bodyModes = { raw: "raw", "form-data": "formdata", urlencoded: "urlencoded", binary: "file", none: "none" };
  var body = {
    toString: function () {
      if (req.body.type === "raw") return req.body.raw;
      if (req.body.type === "urlencoded") {
        return (req.body.urlEncoded || [])
          .filter(function (r) {
            return r.enabled;
          })
          .map(function (r) {
            return encodeURIComponent(r.key) + "=" + encodeURIComponent(r.value);
          })
          .join("&");
      }
      return "";
    },
    update: function (v) {
      guard();
      req.body.raw = str(v);
      if (req.body.type !== "raw") req.body.type = "raw";
    },
  };
  Object.defineProperty(body, "mode", {
    enumerable: true,
    get: function () {
      return bodyModes[req.body.type] || "none";
    },
  });
  Object.defineProperty(body, "raw", {
    enumerable: true,
    get: function () {
      return req.body.raw || "";
    },
    set: function (v) {
      body.update(v);
    },
  });

  var request = { headers: reqHeaders, body: body, id: req.id, name: req.name };
  Object.defineProperty(request, "method", {
    enumerable: true,
    get: function () {
      return req.method;
    },
    set: function (v) {
      guard();
      req.method = str(v).trim().toUpperCase();
    },
  });
  Object.defineProperty(request, "url", {
    enumerable: true,
    get: function () {
      return url;
    },
    set: function (v) {
      guard();
      req.url = str(v);
    },
  });

  // ---- response ----

  function makeResponse(r) {
    var res = {
      code: r.code,
      status: r.status,
      responseTime: r.responseTime,
      responseSize: r.responseSize,
      headers: headerList(function () {
        return r.headers;
      }),
      text: function () {
        return r.body;
      },
      json: function () {
        try {
          return JSON.parse(r.body);
        } catch (e) {
          throw new SyntaxError("JSONError: " + e.message + " (the response body isn't valid JSON)");
        }
      },
    };
    Object.defineProperty(res, "__pmResponse", { value: true });
    Object.defineProperty(res, "to", {
      get: function () {
        return expect(res).to;
      },
    });
    return res;
  }

  // ---- tests ----

  function errorText(e) {
    if (e !== null && typeof e === "object" && "message" in e) return (e.name || "Error") + ": " + e.message;
    return String(e);
  }

  function test(name, fn) {
    name = str(name);
    if (typeof fn !== "function") {
      host.test(name, false, "", true);
      return pm;
    }
    try {
      fn();
    } catch (e) {
      host.test(name, false, errorText(e), false);
      return pm;
    }
    host.test(name, true, "", false);
    return pm;
  }
  test.skip = function (name) {
    host.test(str(name), false, "", true);
    return pm;
  };

  // ---- pm ----

  var data = input.iterationData || {};
  var execution = {
    setNextRequest: function (name) {
      state.nextRequestSet = true;
      state.nextRequest = name === null || name === undefined ? null : str(name);
    },
    skipRequest: function () {
      state.skip = true;
    },
  };

  var pm = {
    environment: environment,
    collectionVariables: scope("collection", "pm.collectionVariables"),
    globals: scope("global", "pm.globals"),
    variables: scope("", "pm.variables"),
    request: request,
    info: {
      eventName: input.event,
      requestName: req.name,
      requestId: req.id,
      iteration: input.iteration,
      iterationCount: input.iterationCount,
    },
    iterationData: {
      get: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
      },
      has: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key);
      },
      toObject: function () {
        return Object.assign({}, data);
      },
      toJSON: function () {
        return Object.assign({}, data);
      },
    },
    execution: execution,
    test: test,
    expect: expect,
    sendRequest: function () {
      fail("pm.sendRequest isn't available: Pakpos scripts have no network access");
    },
  };
  if (input.response) pm.response = makeResponse(input.response);

  // ---- globals ----

  function log(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(typeof a === "string" ? a : lib.inspect(a, { json: true, depth: 5 }));
      }
      host.log(level, parts.join(" "));
    };
  }

  function unavailable(name, why) {
    return function () {
      fail(name + " isn't available in Pakpos scripts: " + why);
    };
  }

  var timers = "scripts run synchronously and stop when they end";
  g.pm = pm;
  g.postman = { setNextRequest: execution.setNextRequest };
  g.console = { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };
  g.setTimeout = unavailable("setTimeout", timers);
  g.setInterval = unavailable("setInterval", timers);
  g.setImmediate = unavailable("setImmediate", timers);
  g.clearTimeout = unavailable("clearTimeout", timers);
  g.clearInterval = unavailable("clearInterval", timers);
  g.require = unavailable("require", "there are no modules to load");
  g.fetch = unavailable("fetch", "scripts have no network access");
  g.btoa = function (s) {
    return host.btoa(str(s));
  };
  g.atob = function (s) {
    return host.atob(str(s));
  };

  return function finish() {
    return JSON.stringify(state);
  };
});
