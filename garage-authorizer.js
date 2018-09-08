var net = require('net');
var http = require('http');
var https = require('https');
var got  = require('got');
var csv = require('csv');
var config = require('./config.js');

var server = net.createServer(function(socket) {
    console.log('client connected from ', socket.remoteAddress);
    socket.setEncoding('utf8');
    var data = '';
    socket.on('end', function() {
        console.log('client disconnected');
        // end of message = \0 \u0000 or NUL
        var in_data = data.split("\0");
        in_data.forEach(function(x) {
            // TODO move to a function
            // broken out by newlines
            var x_lines = x.split("\r\n");
            x_lines.forEach(function(line) {
                const hashComment = /(#.*)/;
                if (hashComment.test(line))
                {
                    return;
                }
                csv.parse(line, function(err, row) {
                    //console.log(row);
                    row.forEach(function(y) {
                        console.log(y);
                        var tag = { "tag_epc" : y[0],
                                    "tag_pc"  : y[6],
                                    "antenna" : y[5],
                                    "rssi"    : y[1]
                        };
                        var tagscan = { "tagscan" : tag };

                        // make sure we parsed some data
                        // TODO more detailed error checking
                        if (y.length < 7)
                        {
                            var error = new Error('Invalid protocol input data received');
                            socket.destroy(error);
                        }
                        else
                        {
                            console.log(JSON.stringify(tagscan));
                            //post_tagscan(JSON.stringify(tagscan));
                            authorize_tag(tag['tag_epc']);
                            socket.end();
                        }
                    });
                });
            });
        });
    });
    socket.on('data', function(chunk) {
        //console.log(data);
        data += chunk;
    });
    socket.on('error', function(e) {
        // TODO how do we handle other errors?
        console.error('Socket error:', e.message);
    });
});

function post_tagscan(data) {
    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = http.request(options, function(res) {
        console.log(`Post status: ${res.statusCode}`);
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
            console.log(`Body: data`);
        });
        res.on('end', function(e) {
            console.error('No more data in response.');
        });
    });

    req.on('error', function(e) {
        console.error(`Problem with post request: ${e.message}`);
        return;
    });

    req.write(data);
    req.end();

    return;
};

function authorize_tag(tag) {
    // note in line below a= is the authorization ie: garage = 1
    // http://localhost:3000/tags/1234566ef/authorize.json?a=1
    let authorize_url = 'http://localhost:3000/tags/'+tag+'/authorize.json?a=1';

    got(
        authorize_url,
        { json: true }
    ).then( (response) => {
        console.log(response.body);
        if(response.body['response'] == 'authorized')
        {
            get_door_state(processDoorState);
            console.log('Tag '+tag+' authorized');
        }
    }).catch( (error) => {
        console.log("Door authorization error: "+error);
    });
};

function get_door_state(callback) {
    // check door state, return 1 if down, 0 if up
    // TODO below should be configurable 
    let api_url = config.particle.api_url;
    let device_id = config.particle.device_id;
    let access_token = config.particle.access_token;

    let url = api_url+device_id+"/doorstate?access_token="+access_token;

    let error = '';
    console.log('get door state API call=', url);
    // get state from particle API
    let result = 'up'; //default to up?
    
    let getOptions = {
        json: true,
    };

    got(
        url,
        getOptions
    ).then( (response) => {
        // default encoding is utf-8
        console.log(response.body);
        result = response.body['result']; //error handling on this?
        callback && callback(error, result);
    }).catch( (error) => {
        //console.log(error);
        callback && callback(error, result);
    });
};

function processDoorState (error, state)  {
    if (error) return console.error("door state error", error)
    if (state == 'down')
    {
        console.log("Door down, opening door");
        openDoor(error);
    } else {
        console.log("Door up, no action ", state);
    }
};

function openDoor (error) {
    if (error) return console.error("ERROR", error)
    // TODO below should be configurable 
    let api_url = config.particle.api_url;
    let device_id = config.particle.device_id;
    let access_token = config.particle.access_token;

    let url = api_url+device_id+"/door1move?access_token="+access_token;

    console.log("APIcall=",url);

    const options = {
        method: 'POST'
    };

    got(
        url, options
    ).then( (response) => {
        let parsedData = '';
        if(response.body)
        {
            parsedData = JSON.parse(response.body);
            console.log(parsedData);
        }
        console.log(response.statusCode);
    }).catch( (error) => {
        console.log("Got error = "+error.statusMessage);
        console.log("error = "+error);
    });
};

server.on('error', function(err) {
    throw err;
});

server.listen(1337, '127.0.0.1', function() {
    console.log('server bound to ', server.address());
});
