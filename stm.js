//  Copyright (c) 2013 David Caldwell,  All Rights Reserved.
var app_port = 9968;
var app_root = [ { path:'/home/david/Movies/', name:'Movies' } ];
var types= ["aif","m2ts","ts","flac","wmv","ogm","ogg","wma","m4a","vob","dif","dv","flv","asf","mp2","mp3","ac3","aac","mpeg4","mp4","m4v","mpeg","mkv","mpg","mov","gvi","avi"];
var valid_type = {}; types.forEach(function (t) { valid_type['.'+t] = true });
var chunk_seconds = 10;
var encode_ahead = 5;

var path     = require('path');
var fs       = require('fs');
var glob     = require('glob');
var Q        = require('q');
var navcodec = require('navcodec');
var spawn    = require('child_process').spawn;
var events   = require('events');
var util     = require('util');

var app = require('http').createServer(handle_http_request);
app.listen(app_port);

function log(message) {
    console.log(Date().toString()+" "+(typeof message == 'string' ? message : JSON.stringify(message)));
}

var session_data = {};

function handle_http_request(req, resp) {
    log(req.method + ' ' + req.url);

    var cookie = {};
    (req.headers.cookie || "").split(/; */).forEach(function(c) {
        var kv=c.split(/=/);
        cookie[kv[0]] = kv[1];
    });

    var session_id = cookie.session || Math.floor(Math.random()*0xffffff+1000);
    if (!cookie.session)
        resp.setHeader("Set-Cookie", ["session="+session_id+"; path=/"]);
    var session = session_data[session_id] = session_data[session_id] || {};

    var url = require('url').parse(req.url);
    if (decodeURIComponent(url.pathname).match(/\.\.(\/|$)/))
        throw ".. attempt";

    var m;
    if (req.url == '/folders') {
        resp.writeHead(200, { 'Content-Type': 'application/json' });
        resp.end(JSON.stringify(app_root.map(function(share) { return { name: share.name, type: 'folder' } })));
    }
    else if (m = url.pathname.match(/^\/contents\/(\d+)(?:\/(.*))?/)) {
        var dir = decodeURIComponent(path.join(app_root[m[1]].path, m[2] || ''));
        var deferred = Q.defer();
        glob("*", { cwd: dir, nosort: true },
             function(err, files) {
                 if (err) deferred.reject(err);
                 else deferred.resolve(files)
             });

        deferred.promise.then(function(file_list) {
            var files = file_list.map(function(f) {
                return { name: f, stats: fs.statSync(path.join(dir,f)) }
            });

            resp.writeHead(200, { 'Content-Type': 'application/json',
                                  // 'Set-Cookie',chocchip.output(header=''))
                                  // 'Servetome-Version',STM_VERSION)
                                  // 'Connection','close')
                                  // 'Json-Length',len(response))
                                  // 'Content-Length',len(response))
                                });
            resp.end(JSON.stringify(files
                                    .filter(function(f) { return !f.name.match(/^\./) && (f.stats.isDirectory() || valid_type[path.extname(f.name)]) })
                                    .map(function(f) {
                                        return { name: f.name, type: f.stats.isDirectory() ? 'folder' : 'file' }
                                    })));
        })
        .done();
    }
    else if (m = url.pathname.match(/^\/metadata\/(\d+)(?:\/(.*))?$/)) {
        var file = decodeURIComponent(path.join(app_root[m[1]].path, m[2] || ''));


        // ffmpeg-stm returns:
        // {"artist":"Buffy The Vampire Slayer","title":"When She Was Bad","length":2725.034667,"audio_streams":[{"language":"eng","trans":"-----"},{"language":"eng","trans":"c----"}],"subtitle_streams":[],"has_video":true,"trans":"--h-v--b--"}
        // {"length":2647.776000,"audio_streams":[{"language":"und","trans":"ccb--"}],"subtitle_streams":[],"has_video":true,"trans":"-lh-vwh---"}
        Q.all([get_metadata(file),
               get_thumbnail(file)])
        .spread(function(media, thumbnail) {
            var json = JSON.stringify({
                artist: media.metadata.show,
                title: media.metadata.title,
                length: media.duration,
                description: media.metadata.description
            });
            resp.writeHead(200, { 'Content-Type': 'application/json',
                                  'Json-Length': json.length,
                                  'Content-Length': json.length + thumbnail.length,
                                });
            // Yes, we catenate text and binary data together under the banner of application/json. Don't blame me, I didn't design this.
            resp.end(Buffer.concat([new Buffer(json),thumbnail]))
            log("metadata: "+json);
        })
        .done();
    }

    // GET /stream/device=Mac,rate=local,aud=any,sub=any,ss=0,gain=0,art=yes,dir=default,enc=Auto,pdur=8,trans=both/0/TV/14%20NCIS.S10E14.720p.HDTV.X264-DIMENSION.mkv/index.m3u8?offset=0.000000
    else if (m = url.pathname.match(/^\/stream\/([^\/]+)\/(\d+)\/(.*)\/(\w+)(?:\.(m3u8)|-(\d+)\.(ts))$/)) {
        var option_string = m[1];
        var opts = {};
        option_string.split(/,/).forEach(function(o) {
            var kv=o.split(/=/);
            opts[kv[0]] = kv[1];
        });

        var videofile = decodeURIComponent(path.join(app_root[m[2]].path, m[3]));
        var rate = m[4];
        var chunknum = m[6]-0;
        var filetype = m[5] || m[7];

        if (!session.transcode || session.transcode.input_file != videofile) {
            if (session.transcode)
                session.transcode.stop();
            session.transcode = new Transcode(videofile, opts);
            log("Starting transcode for session "+session_id);
        }

        if (rate == "index" && filetype == "m3u8") {
            resp.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            resp.end(session.transcode.master_m3u8());
            return;
        } else if (filetype == "m3u8") {
            log("Getting m3u8 for rate "+rate);
            session.transcode.m3u8(rate)
                   .then(function(data) {
                       resp.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                       resp.end(data);
                   })
                   .done();
            return;
        }

        log("Getting chunk "+chunknum+" for rate "+rate);
        return session.transcode.chunk(rate, chunknum)
               .then(function(data) {
                   log("Delivering "+rate+"["+chunknum+"]");
                   resp.writeHead(200, { 'Content-Type': 'video/MP2T' }); // stm.py uses 'application/vnd.apple.mpegurl' here.
                   resp.end(data);
               }, function(error) {
                   resp.writeHead(500, { 'Content-Type': 'text/plain' });
                   resp.end(error.toString());
               })
               .done();
    }

    else
        resp.end();
}


function get_metadata(file) {
    return navcodec.open(file)
        .then(function(media) {
            log("Metadata for: "+file);
            log(media.metadata);
            log({duration: media.duration,
                         width: media.width,
                         height: media.height,
                         videoBitrate: media.videoBitrate,
                         audioBitrate: media.audioBitrate,
                         bitrate: media.bitrate,
                         samplerate: media.samplerate,
                        });
            return Q.resolve(media);
        });
}

function get_thumbnail(file) {
    var param;
    var ffmpeg = spawn('ffmpeg', param=['-y',
                                        '-noaccurate_seek',
                                        '-ss', '15',
                                        '-i', file,
                                        '-frames:v', '1',
                                        '-r', '1',
                                        '-filter', 'scale=width=108:height=-1',
                                        '-f', 'image2',
                                        '-'
                                       ]);
    var deferred = Q.defer();
    var jpeg=[], stderr='';
    //ffmpeg.stdout.setEncoding('binary'); // Do not set encoding! If you do it will become *not* binary, no matter what you do. See: https://github.com/joyent/node/blob/v0.10.22-release/lib/_stream_readable.js#L193
    ffmpeg.stdout.on('data', function(data) { jpeg.push(data); });
    ffmpeg.stderr.on('data', function(data) { stderr += data; });
    ffmpeg.on('close', function(code) {
        if (code == 0)
            deferred.resolve(Buffer.concat(jpeg));
        else
            deferred.reject(stderr+"\n"+
                            "ffmpeg exited with code "+code+"\n");
    });
    return deferred.promise;
}

var common_ffmpeg_opts = { '-ar': 48000,
                           '-vprofile': 'baseline',
                           '-level': 30,
                           '-me_range': 16,
                           '-sc_threshold': 0,
                           '-qmin': 15,
                           '-qmax': 51,
                           '-qdiff': 4,
                           '-flags': '+loop',
//                           '-cmp': '+chroma',
                           '-partitions': '+parti8x8+parti4x4+partp8x8+partb8x8',
                           '-bufsize': 2048 * 1024,
                           '-minrate': 0,
                         };

var _keys =   [ 'rate',   '-maxrate','-b:a',   '-ac',
                                                  '-qcomp',
                                                          '-subq',
                                                             '-refs',
                                                                '-crf',
                                                                    '-me_method',
                                                                           'maxwidth',
                                                                                 'maxheight'];
var _rates = {
    veryhigh: [ 2048000,  2304*1024, 192*1024, 2, '0.35', 1, 1, 24, 'hex', 1280, 720 ],
    high:     [ 1440000,  1440*1024, 192*1024, 2, '0.35', 4, 1, 24, 'hex',  640, 480 ],
    midhigh:  [  720000,   720*1024, 128*1024, 2, '0.25', 4, 1, 24, 'dia',  480, 320 ],
    mid:      [  360000,   288*1024,  96*1024, 2, '0.15', 4, 2, 25, 'dia',  360, 240 ],
    midlow:   [  144000,    84*1024,  48*1024, 1, '0.15', 8, 4, 23, 'umh',  240, 160 ],
    low:      [   96000,    72*1024,  32*1024, 1, '0.15', 8, 6, 25, 'umh',  192, 128 ],
    verylow:  [   64000,    48*1024,  16*1024, 1, '0',    8, 6, 23, 'umh',  192, 128 ],
};

var rates = {};
for (var r in _rates) {
    rates[r] = {}
    for (var k in _keys)
        rates[r][_keys[k]] = _rates[r][k];
    //rates[r]['-b'] = rates[r]['-maxrate'] + rates[r]['-b:a'];
}

for (var li in rates)
    for (var oi in common_ffmpeg_opts)
        if (rates[li][oi] == undefined)
            rates[li][oi] = common_ffmpeg_opts[oi];

function Transcode(file, options) {
    log("Transcode file: "+file+" with options: "+JSON.stringify(options));

    this.input_file = file;

    this.meta = get_metadata(file);
}

Transcode.prototype.stop = function() {
    if (this.encoder)
        this.encoder.kill();
}

Transcode.prototype.chunkname = function(rate, chunk_num){ return rate + "-" + chunk_num + ".ts" };
Transcode.prototype.chunk = function(rate, chunk_num) {
    if (this.encoder_error) {
        var e = this.encoder_error;
        delete this.encoder_error;
        return Q.resolve(e);
    }

    if (!this.encoder ||
        this.rate != rate ||
        this.next_chunk_num != chunk_num)  {
        log("Starting new transcode "+JSON.stringify([this.encoder ? "this.encoder" : null, this.rate, rate, this.next_chunk_num, chunk_num]));
        this.start(rate, chunk_num);
    }

    var _this = this;
    return this.next_chunk_promise.then(function(chunk) {
        log("Kicking transcode");
        _this.kick();
        return chunk;
    });
}

Transcode.prototype.start = function(rate, chunk_num) {
    var mpeg2ts = require('./mpeg2ts');
    this.next_encoded_chunk = chunk_num;
    this.next_chunk_num = chunk_num;
    this.next_chunk_deferred = Q.defer();
    this.next_chunk_promise = this.next_chunk_deferred.promise;
    this.rate = rate;
    this.fifo = [];

    this.packetizer = new mpeg2ts.Packetizer();
    this.chunkifier = new mpeg2ts.TimeBasedChunkifier(chunk_seconds/*, chunk_num*chunk_seconds*/);

    this.stop();

    var _this = this;
    this.meta.then(function(media) {
        log("Starting encode for "+_this.input_file+" "+rate+"["+chunk_num+"]");
        try {
        _this.encoder = new Encode(_this.input_file, rate, chunk_num, media);
        } catch(e) {
            log(e.message);
            throw(e);
        }
        _this.encoder.on('data', function(data) {
            // log("Giving packetizer "+data.length+" bytes");
            _this.packetizer.write(data);
        });
        _this.encoder.on('close', function() {
            _this.chunkifier.flush();
        });
        _this.encoder.on('error', function(message) {
            _this.encoder_error = message;
            log("error! "+message);
        });
    });

    this.packetizer.on('packet', function(packet) {
        // log("Giving chunkifier a packet.");
        _this.chunkifier.writePacket(packet);
    });
    this.chunkifier.on('chunk', function(packets) {
        var chunk = Buffer.concat(packets);
        log("got chunk: "+packets.length+" packets ("+chunk.length+" bytes)");
        if (_this.next_encoded_chunk == _this.next_chunk_num)
            _this.next_chunk_deferred.resolve(chunk);
        else {
            _this.fifo.push(chunk);
            log("Pushing chunk into fifo (now "+_this.fifo.length+" deep)");
            if (_this.fifo.length >= encode_ahead)
                _this.encoder.pause();
        }
        _this.next_encoded_chunk++;
    });
}

Transcode.prototype.kick = function() {
    this.encoder.resume(); // the spice must flow

    this.next_chunk_num++;
    this.next_chunk_deferred = Q.defer();
    this.next_chunk_promise = this.next_chunk_deferred.promise;
    if (this.fifo.length) {
        log("Shifting chunk out of fifo");
        this.next_chunk_deferred.resolve(this.fifo.shift());
    }
}

Array.prototype.flatten = function() { // Only flattens one level.
    return Array.prototype.concat.apply([], this);
}

function shrink_to_fit(size, max) {
    if (size.w < max.w && size.h < max.h)
        return;
    var fit = {};
    var sa = size.w/size.h, ma = max.w/max.h;
    if (sa > ma) {
        fit.w = Math.min(size.w, max.w);
        fit.h = fit.w / sa;
    } else {
        fit.h = Math.min(size.h, max.h);
        fit.w = fit.h * sa;
    }
    fit.w = fit.w & ~1; // mpeg likes things rounded to even numbers
    fit.h = fit.h & ~1;
    return fit;
}

function Encode(input_file, rate, chunk_num, media, data_callback) {
    events.EventEmitter.call(this);
    var resize = shrink_to_fit({w:media.width, h:media.height}, {w:rates[rate].maxwidth, h:rates[rate].maxheight});
    var param;
    log("spawning ffmpeg");
    this.input_file = input_file;
    this.process = spawn('ffmpeg', param=[].concat([ '-y',
                                                   '-accurate_seek',
                                                   '-ss', chunk_num * chunk_seconds,
                                                   '-i', input_file,
                                                   '-f', 'mpegts',
                                                   '-codec:a', 'libmp3lame',
                                                   '-codec:v', 'h264',
                                                 ],
                                                 Object.keys(rates[rate])
                                                 .filter(function(opt) { return opt[0] == '-' })
                                                 .map(function(opt) { return [ opt, rates[rate][opt] ] }).flatten(),
                                                 resize ? ['-filter:v', 'scale=width='+resize.w+':height='+resize.h] : [],
                                                 ["-"])
                                 );
    log("ffmpeg ["+this.process.pid+"] started for "+rate+"["+chunk_num+"]: ffmpeg "+param.map(function(p) { return (''+p).match(/ /) ? '"'+p+'"' : p }).join(' '));

    var _this=this;
    this.process.stdout.resume();
    this.process.stdout.on('data', function (data) {
        // log("Got data from ffmpeg ("+data.length+" bytes)");
        _this.emit('data', data);
    });

    var stderr = '';
    this.process.stderr.on('data', function (data) {
         stderr += data;
    });

    this.process.on('close', function(code) {
        log("ffmpeg ["+this.process.pid+"] exited ("+code+")");
        if (code != 0 && code != undefined) {
            log(stderr+"\n"+
                "error: ffmpeg exited with code "+code);
            _this.emit('error', stderr);
        } else
            _this.emit('close');
    });
}
util.inherits(Encode, events.EventEmitter);
Encode.prototype.kill = function()
{
    log("Killing "+this.process.pid);
    this.process.kill('SIGKILL');
}
Encode.prototype.pause = function() {
    log("Pausing "+this.input_file+"["+this.process.pid+"]");
    this.process.stdout.pause();
}
Encode.prototype.resume = function() {
    log("Resuming "+this.input_file+"["+this.process.pid+"]");
    this.process.stdout.resume();
}

Transcode.prototype.master_m3u8 = function() {
    var _this = this;
    return "#EXTM3U\n" +
        Object.keys(rates).sort(function(a,b) { return rates[b]['rate'] - rates[a]['rate'] })
        .map(function(r) { return "#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH="+rates[r]['rate']+"\n" +
                                  r+".m3u8\n" })
        .join('');
}

Transcode.prototype.m3u8 = function(rate) {
    var _this = this;
    return this.meta.then(function (media) {
        var chunks = Math.ceil(media.duration / chunk_seconds);
        var m3u8 = "#EXTM3U\n" +
                   "#EXT-X-TARGETDURATION:"+chunk_seconds+"\n";
        for (var i=0; i<chunks; i++)
            m3u8 += "#EXTINF:"+chunk_seconds+",\n" +
                    _this.chunkname(rate, i)+"\n";
        m3u8 += "#EXT-X-ENDLIST\n";
       return Q.resolve(m3u8);
    });
}
