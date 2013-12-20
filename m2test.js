//  Copyright (c) 2013 David Caldwell,  All Rights Reserved.

// Pipe a transport stream through this to test mpeg2ts.js

var packetizer = new (require('./mpeg2ts')).Packetizer();
var chunkifier = new (require('./mpeg2ts')).TimeBasedChunkifier(5);

packetizer.on('packet', function(packet) {
    chunkifier.writePacket(packet);
});

var chunk_num = 0;
chunkifier.on('chunk', function(packets) {
    console.log(packets.length + " packets in chunk "+chunk_num+", total length="+packets.reduce(function(prev_val, val, index, obj) { return obj.length + prev_val }, 0));
    chunk_num++;
});

process.stdin.resume();
process.stdin.on('data', function(chunk) {
  packetizer.write(chunk);
});
