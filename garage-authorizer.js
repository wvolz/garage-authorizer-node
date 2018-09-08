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
    http.get('http://localhost:3000/tags/'+tag+'/authorize.json?a=1', function(res) {
        const { statusCode } = res;
        const contentType = res.headers['content-type'];

        let error;
        if (statusCode !== 200)
        {
            error = new Error('Authorization request failed, ' +
                              `Status Code: ${statusCode}`);
        }
        else if (!/^application\/json/.test(contentType))
        {
            error = new Error('Invalid content-type. ' +
                              `Expected application/json but received ${contentType}`);
        } 
        
        if (error)
        {
            console.error(error.message);
            res.resume();
            return;
        }

        res.setEncoding('utf8');
        let rawData='';
        res.on('data', function(chunk) {
            rawData += chunk; });
        res.on('end', function() {
            try
            {
                const parsedData = JSON.parse(rawData);
                console.log(parsedData);
                if (parsedData['response'] == 'authorized')
                {
                    //call garage open?
                    get_door_state(processDoorState);
                    console.log('Successful authorization');
                }
            }
            catch (e)
            {
                console.error(e.message);
            }
        });
    }).on('error', function(e) {
        console.error(`Problem with authorization request: ${e.message}`);
    });

    return;
};

function get_door_state(callback) {
    // check door state, return 1 if down, 0 if up
    // TODO below should be configurable 
    let api_url = config.particle.api_url;
    let device_id = config.particle.device_id;
    let access_token = config.particle.access_token;

    let url = api_url+device_id+"/doorstate?access_token="+access_token;

    let error = '';
    console.log('get door state ', url);
    // get state from particle API
    let result = 'up'; //default to up?
    https.get(url, function(res) {
        const { statusCode } = res;
        const contentType = res.headers['content-type'];
        //console.log('headers:', res.headers);
        //console.log('statusCode:', res.statusCode);

        let error;
        if (statusCode !== 200) {
            error = new Error('Request Failed.\n' +
                `Status Code: ${statusCode}`);
        } else if (!/^application\/json/.test(contentType)) {
            error = new Error('Invalid content-type.\n' +
                `Expected application/json but received ${contentType}`);
        }
        if (error) {
            error = error.message;
            console.error(error);
            // consume response data to free up memory
            res.resume();
            return;
        }

        res.setEncoding('utf8');
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          try {
            const parsedData = JSON.parse(rawData);
            console.log(parsedData);
            result = parsedData['result']; //error handling on this?
            //console.log(result);
          } catch (e) {
            console.error(e.message);
          }
          callback && callback(error, result);
        });
    }).on('error', function(e) {
        console.error(`door state api call error: ${e.message}`);
    });
};

function processDoorState (error, state)  {
    if (error) return console.error("ERROR", error)
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
