// mpeg2ts.js - Parse and chunkify MPEG2 Transport Streams.
// Copyright (c) 2013-2014 David Caldwell.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

var MPEG_TS_PACKET_LENGTH = 188;

var util = require('util');
var events = require('events');


function Packetizer() {
    events.EventEmitter.call(this);
    this.partial = new Buffer(0);
}
util.inherits(Packetizer, events.EventEmitter);

Packetizer.prototype.write = function(data) {
    this.partial = Buffer.concat([this.partial, data]);
    while (this.partial.length > MPEG_TS_PACKET_LENGTH) {
        this.emit('packet', this.partial.slice(0, MPEG_TS_PACKET_LENGTH));
        this.partial = this.partial.slice(MPEG_TS_PACKET_LENGTH);
    }
}

function TimeBasedChunkifier(chunk_seconds) {
    events.EventEmitter.call(this);
    this.packets = [];
    this.chunk_seconds = chunk_seconds;
    this.next_chunk_time = -1;
}
util.inherits(TimeBasedChunkifier, events.EventEmitter);

var packet_num = 0;
TimeBasedChunkifier.prototype.writePacket = function(packet) {
    // console.log("Packet "+packet_num+": "+packet.length+" bytes.");
    packet_num++;

    this.packets.push(packet);

    if (packet.readUInt8(3) & 0x20 && // Adaptation Field Exist flag
        packet.readUInt8(5) & 0x10) { // PCR flag
        var pcr_0 = packet.readUInt32BE(6);
        var pcr_1 = packet.readUInt16BE(10);
        var pcr_reallyhi = pcr_0 & 0x80000000 ? 1 : 0; // ignored for now. Will break if stream is longer than 13 hours :-)
        var pcr_hi = (pcr_0 & 0x7fffffff) << 1 | (pcr_1 & 0x8000 ? 1 : 0);
        var pcr_lo = pcr_1 & 0x3f;
        var seconds = (pcr_hi/90000 + pcr_lo/27000000);
        this.emit('pcr', seconds, pcr_hi, pcr_lo, pcr_0, pcr_1);
        //console.log('PCR: '+seconds+' <- '+pcr_hi+'_'+pcr_lo+' ['+pcr_0.toString(16)+' '+pcr_1.toString(16)+']');

        if (this.pcr_offset)
            packet.writeUInt32BE(pcr_0 + this.pcr_offset, 6);

        if (this.next_chunk_time < 0) // Base ourselves off the first PCR. It maybe not be zero.
            this.next_chunk_time = seconds + this.chunk_seconds;

        if (seconds > this.next_chunk_time) {
            this.emit('chunk', this.packets);
            this.packets = [];
            this.next_chunk_time += this.chunk_seconds;
        }
    }
}

TimeBasedChunkifier.prototype.flush = function() {
    if (this.packets.length) {
        this.emit('chunk', this.packets);
        this.packets = [];
    }
}

exports.Packetizer = Packetizer;
exports.TimeBasedChunkifier = TimeBasedChunkifier;
