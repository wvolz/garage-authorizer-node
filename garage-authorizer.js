import net from "node:net";
import csv from "csv";
import cache from "memory-cache";
import got from "got";
import pino from "pino";
import config from "./config.js";
import util from "node:util";

const logger = pino({
  prettyPrint: {
    colorize: true,
    translateTime: "SYS:standard",
  },
});

var doorStateUpdateInProcess = 0;

// TODO: need to make address for auth server configurable
// TODO: what happens when multiple clients connect and send data?
var server = net.createServer(function (socket) {
  logger.info("client connected from ", socket.remoteAddress);
  socket.setEncoding("utf8");
  // below addresses TODO to set a timeout on connections
  // TODO does this address memory / wrong type of client?
  // think web broswer that reconnects over and over
  socket.setTimeout(3000);
  var data = "";
  socket.on("end", function () {
    logger.info("client disconnected");
  });
  socket.on("data", function (chunk) {
    //logger.debug(data);
    data += chunk;
    // look for NUL to indicate a complete set of data
    // from the reader/end of message from the reader
    // TODO need to timeout connection to avoid using up
    // memory due to connection that never closes + no
    // NUL terminators found
    var d_index = data.indexOf("\0");
    while (d_index > -1) {
      try {
        var string = data.substring(0, d_index);
        // call process function here
        parse_input(string);
        logger.info("Nul terminated input=" + string);
      } catch (error) {
        logger.error("Inbound data parse error: " + error);
      }
      data = data.substring(d_index + 1);
      d_index = data.indexOf("\0"); // find next delimiter in buffer
    }
  });
  socket.on("error", function (e) {
    // TODO how do we handle other errors?
    logger.error("Socket error:", e.message);
  });
  socket.on("timeout", () => {
    logger.info("socket timeout");
    socket.end();
  });
});

function parse_input(data) {
  // end of message = \0 \u0000 or NUL
  var in_data = data.split("\0");
  in_data.forEach(function (x) {
    // broken out by newlines
    var x_lines = x.split("\r\n");
    x_lines.forEach(function (line) {
      const hashComment = /(#.*)/;
      if (hashComment.test(line)) {
        return;
      }
      csv.parse(line, function (err, row) {
        //logger.debug(row);
        row.forEach(function (y) {
          logger.info(y);
          var tag = { tag_epc: y[0], tag_pc: y[6], antenna: y[5], rssi: y[1] };
          var tagscan = { tagscan: tag };

          // make sure we parsed some data
          // TODO more detailed error checking
          if (y.length < 7) {
            var error = new Error("Invalid protocol input data received");
            //TODO do we need to hangup the connection here?
            //socket.destroy(error);
          } else {
            logger.info(JSON.stringify(tagscan));
            post_tagscan(tagscan);
            // filter out false readings from antenna 0
            if (tag["antenna"] == 1) {
              authorize_tag(tag["tag_epc"]);
            }
            //TODO do we need to hangup the connection here?
            //socket.end();
          }
        });
      });
    });
  });
}

function post_tagscan(data) {
  let data_post_url = config.tagscan_url;
  let api_token = config.api_token;

  let gotOptions = {
    json: data,
    headers: {
      Authorization: "Bearer " + api_token,
    },
  };

  got
    .post(
      data_post_url,
      gotOptions,
      /*).then( (response) => {
        // check for success here?
    }*/
    )
    .catch((error) => {
      logger.error(`Problem with post request (${error.code}): ${error}`);
    });
}

function authorize_tag(tag) {
  // note in line below a= is the authorization ie: garage = 1
  // http://localhost:3000/tags/1234566ef/authorize.json?a=1
  let tagauthorize_host = config.tagauthorize_host;
  let authorize_url =
    tagauthorize_host + "/tags/" + tag + "/authorize.json?a=1";
  let api_token = config.api_token;
  let cache_key = "__garage_authorizer__" + "/authorizing/" + tag;

  // check cache for key, if present skip authorization/opening
  let result = cache.get(cache_key);
  logger.info("authorizing tag");
  if (result) {
    // value cached so we can assume we don't have to do anything
    logger.info("skipping authorization for " + tag + " due to cache hit!");
    return;
  } else {
    // cache the fact that we are processing this tag
    // cache for 30 seconds
    cache.put(cache_key, "1", 30000);
    got(authorize_url, {
      headers: {
        Authorization: "Bearer " + api_token,
      },
    })
      .json()
      .then((auth_reply) => {
        logger.info("Auth reply = " + util.inspect(auth_reply));
        if (auth_reply["response"] == "authorized") {
          get_door_state(processDoorState);
          logger.info("Tag " + tag + " authorized");
        }
      })
      .catch((error) => {
        logger.error("Door authorization error (" + error.code + "): " + error);
      });
  }
}

function get_door_state(callback) {
  // check door state
  // TODO reduce number of calls to "callback"
  // TODO below should be configurable
  let api_url = config.particle.api_url;
  let device_id = config.particle.device_id;
  let access_token = config.particle.access_token;

  let url = api_url + device_id + "/doorstate?access_token=" + access_token;

  let error = "";
  let result = "up"; //default to up?
  let cache_key = "__garage_authorizer__" + "/doorState";
  // check to see if we have a cached door state to reduce API calls
  // TODO make door state cache timeout configurable?
  let door_state_cached = cache.get(cache_key);
  if (door_state_cached) {
    logger.info("using cached result for door state");
    callback && callback(error, door_state_cached);
  } else {
    if (doorStateUpdateInProcess) {
      logger.info("skipped door state API call due to pending update");
    } else {
      logger.info("get door state API call=", url);
      doorStateUpdateInProcess = 1;
      // get state from particle API
      got(url)
        .json()
        .then((api_response) => {
          // default encoding is utf-8
          logger.info("Response = " + util.inspect(api_response));
          result = api_response["result"]; //error handling on this?
          // add state to cache for 15 seconds
          cache.put(cache_key, result, 15000);
          doorStateUpdateInProcess = 0;
          callback && callback(error, result);
        })
        .catch((error) => {
          //logger.warn(error);
          // Don't update door state here?
          doorStateUpdateInProcess = 0;
          callback && callback(error, result);
        });
    }
  }
}

function processDoorState(error, state) {
  if (error) return logger.error("door state error", error);
  if (state == "down") {
    logger.info("Door down, opening door");
    openDoor(error);
  } else {
    logger.info("Door up, no action needed");
  }
}

function openDoor(error) {
  if (error) return logger.error("ERROR", error);
  // TODO below should be configurable
  let api_url = config.particle.api_url;
  let device_id = config.particle.device_id;
  let access_token = config.particle.access_token;

  let url = api_url + device_id + "/door1move?access_token=" + access_token;

  logger.info("openDoor API request URL = ", url);

  got
    .post(url)
    .json()
    .then((api_response) => {
      logger.info("openDoor api response = " + util.inspect(api_response));
    })
    .catch((error) => {
      logger.error("Error moving door = " + error);
    });
}

server.on("error", function (err) {
  throw err;
});

server.listen(
  config.listen_port || 1337,
  config.listen_addr || "127.0.0.1",
  function () {
    logger.info("server bound to ", server.address());
  },
);
