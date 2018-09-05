var net = require('net');
var http = require('http');
var csv = require('csv');

var server = net.createServer(function(socket) {
    console.log('client connected from ', socket.remoteAddress);
    socket.setEncoding('utf8');
    socket.on('end', function() {
        console.log('client disconnected');
    });
    // end of message = \0 \u0000 or NUL
    socket.on('data', function(data) {
        //console.log(data);
        in_data = data.split("\0");
        in_data.forEach(function(x) {
            // TODO move to a function
            // broken out by newlines
            x_lines = x.split("\r\n");
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
    // http://localhost:3000/tags/E200001715120070171065FE/authorize.json?a=1
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

server.on('error', function(err) {
    throw err;
});

server.listen(1337, '127.0.0.1', function() {
    console.log('server bound to ', server.address());
});
