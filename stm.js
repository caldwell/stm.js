//  Copyright (c) 2013 David Caldwell,  All Rights Reserved.
var app_port = 9968;
var app_root = [ { path:'/home/david/Movies/', name:'Movies' } ];
var transcode_dir = '/home/david/.stm-node';
var types= ["aif","m2ts","ts","flac","wmv","ogm","ogg","wma","m4a","vob","dif","dv","flv","asf","mp2","mp3","ac3","aac","mpeg4","mp4","m4v","mpeg","mkv","mpg","mov","gvi","avi"];
var valid_type = {}; types.forEach(function (t) { valid_type['.'+t] = true });
var chunk_seconds = 5;
var encode_ahead = 5;

var path     = require('path');
var fs       = require('fs');
var glob     = require('glob');
var Q        = require('q');
var navcodec = require('navcodec');
var spawn    = require('child_process').spawn;

var app = require('http').createServer(handle_http_request);
app.listen(app_port);

function log(message) {
    console.log(Date().toString()+" "+(typeof message == 'string' ? message : JSON.stringify(message)));
}

function handle_http_request(req, resp) {
    log(req.method + ' ' + req.url);

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
        get_metadata(file)
        .then(function(media) {
            resp.writeHead(200, { 'Content-Type': 'application/json' });
            var x;
            resp.end(JSON.stringify(x={
                artist: media.metadata.show,
                title: media.metadata.title,
                length: media.duration,
                description: media.metadata.description
            }))
            log("metadata: "+JSON.stringify(x));
        })
        .done();
    }

    // GET /stream/device=Mac,rate=local,aud=any,sub=any,ss=0,gain=0,art=yes,dir=default,enc=Auto,pdur=8,trans=both/0/TV/14%20NCIS.S10E14.720p.HDTV.X264-DIMENSION.mkv/index.m3u8?offset=0.000000
    else if (m = url.pathname.match(/^\/stream\/([^\/]+)\/(\d+)\/(.*)\/index\.m3u8$/)) {
        var option_string = m[1];
        var opts = {};
        option_string.split(/,/).forEach(function(o) {
            var kv=o.split(/=/);
            opts[kv[0]] = kv[1];
        });

        var cookie = decodeURIComponent(m[2] + "/" + m[3]);

        var file = decodeURIComponent(path.join(app_root[m[2]].path, m[3]));

        log("Starting transcode with cookie "+cookie);
        var tcode = Transcode.session(cookie, file, opts);
        resp.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        resp.end(tcode.master_m3u8());
    }

    else if (m = url.pathname.match(/^\/session\/([^\/]+)\/(.*)(?:\.(m3u8)|-(\d+)\.(ts))$/)) {
        var cookie = decodeURIComponent(m[1]);
        var rate = m[2];
        var chunknum = m[4]-0;
        var filetype = m[3] || m[5];

        var tcode = Transcode.session(cookie);
        log("cookie="+cookie);

        if (!tcode) {
            resp.writeHead(404, { 'Content-Type': 'application/json' });
            return resp.end(JSON.stringify({ error: "Session not found", session:cookie }));
        }

        if (filetype == 'm3u8') {
            log("Getting m3u8 for rate "+rate);
            return tcode.m3u8(rate)
                   .then(function(data) {
                       resp.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                       resp.end(data);
                   })
                   .done();
        }

        log("Getting chunk "+chunknum+" for rate "+rate);
        return tcode.chunk(rate, chunknum)
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

var rates = {
    'veryhigh': 2048000,
    'high':     1440000,
    'midhigh':   720000,
    'mid':       360000,
    'midlow':    144000,
    'low':        96000,
    'verylow':    64000
}

function mkdir(dir) {
    log('mkdir "'+dir+'"');
    try {
        fs.mkdirSync(dir);
    } catch(e) {
        if (e.code != 'EEXIST')
            throw(e);
    }
}

function Transcode(cookie, file, options) {
    this.promises = [];

    mkdir(transcode_dir);
    log("Transcode file: "+file+" with options: "+JSON.stringify(options));

    this.input_file = file;
    this.cookie = cookie;
    this.dir = path.join(transcode_dir, this.cookie);

    this.meta = get_metadata(file);
}

Transcode.cookieify = function(file) { return file.replace(/\//g, '_') };
Transcode.sessions = [];
Transcode.session = function(_cookie, file, opts) {
    var cookie = Transcode.cookieify(_cookie);
    if (!Transcode.sessions[cookie] && file)
        Transcode.sessions[cookie] = new Transcode(cookie, file, opts);
    return Transcode.sessions[cookie];
};

Transcode.prototype.chunkname = function(rate, chunk_num){ return rate + "-" + chunk_num + ".ts" };
Transcode.prototype.chunkpath = function(rate, chunk_num){ return path.join(this.dir, this.chunkname(rate,chunk_num)) }
Transcode.prototype.chunk = function(rate, chunk_num) {
    this.last_chunk_requested = chunk_num;

    if (this.encoding)
        log("current="+this.encoding.rate+"["+this.encoding.chunk_num+"], request="+rate+"["+chunk_num+"]");

    var _this=this;
    return this.kick(rate, chunk_num)
           .then(function(filename) {
               return Q.nfcall(fs.readFile, filename);
           });
}

Transcode.prototype.kick = function(rate, chunk_num) {
    if (this.encoding &&
        this.encoding.rate == rate &&
        this.encoding.chunk_num == chunk_num)
        return this.encoding.promise;

    var _this = this;
    return this.meta.then(function(media) {
        var chunks = Math.ceil(media.duration / chunk_seconds);
        if (chunk_num >= chunks)
            return;

        var filename = _this.chunkpath(rate,chunk_num);
        if (fs.existsSync(filename))
            var promise = Q.resolve(filename)
        else {
            if (_this.encoding && _this.encoding.process) {
                log("Killing "+_this.encoding.process.pid);
                _this.encoding.process.kill('SIGKILL');
            }
            _this.encoding = { rate: rate,
                               chunk_num: chunk_num,
                             };
            var promise = _this.encoding.promise = _this.encode(rate, chunk_num);
        }
        return promise
               .then(function(filename) {
                   if (_this.encoding && filename == _this.chunkpath(_this.encoding.rate, _this.encoding.chunk_num))
                       delete _this.encoding;
                   if (_this.last_chunk_requested + encode_ahead > chunk_num)
                       _this.kick(rate, chunk_num+1);
                   log("kicking? "+_this.last_chunk_requested+" + "+encode_ahead+" < "+chunk_num);
                   return filename;
               });
    });
}

Transcode.prototype.encode = function(rate, chunk_num) {
    mkdir(this.dir);
    var filename         = this.chunkpath(rate,chunk_num);
    var filename_partial = filename + ".partial";
    var param;
    var ffmpeg = spawn('ffmpeg', param=[ '-y',
                                   '-accurate_seek',
                                   '-ss', chunk_num * chunk_seconds,
                                   '-i', this.input_file,
                                   '-t', chunk_seconds,
                                   '-codec:v', 'h264',
                                   '-codec:a', 'libfaac',
                                   '-b:v', rates[rate],
                                   '-b:a', '192k',
                                   '-f', 'mpegts',
                                   filename_partial
                                 ]);
    this.encoding.process = ffmpeg;
    log("ffmpeg ["+ffmpeg.pid+"] started for "+rate+"["+chunk_num+"]: "+JSON.stringify(param));
    var stderr = '';
    ffmpeg.stderr.on('data', function (data) {
         stderr += data;
    });
    var deferred = Q.defer();
    var _this = this;
    ffmpeg.on('close', function(code) {
        log("ffmpeg ["+ffmpeg.pid+"] exited ("+code+")");
        if (code != 0 && code != undefined /* SIGKILL causes this */)
            return fs.unlink(filename_partial, function() {
                       log(stderr+"\n"+
                           "error: ffmpeg exited with code "+code);
                       deferred.reject("ffmpeg exited with code "+code);
                   });
        return Q.nfcall(fs.rename, filename_partial, filename)
               .then(function(data) {
                   deferred.resolve(filename);
               }, function(err) {
                   deferred.reject(err);
               });
    });
    return deferred.promise;
}

Transcode.prototype.master_m3u8 = function() {
    var _this = this;
    return "#EXTM3U\n" +
        Object.keys(rates).sort(function(a,b) { return rates[b] - rates[a] })
        .map(function(r) { return "#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH="+rates[r]+"\n" +
                                  "/session/"+encodeURIComponent(_this.cookie)+"/"+r+".m3u8\n" })
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
                    "/session/"+encodeURIComponent(_this.cookie)+"/"+_this.chunkname(rate, i)+"\n";
        m3u8 += "#EXT-X-ENDLIST\n";
       return Q.resolve(m3u8);
    });
}
