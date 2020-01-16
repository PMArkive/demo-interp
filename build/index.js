"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bit_buffer_1 = require("bit-buffer");
const fs_1 = require("fs");
const DynamicBitStream_1 = require("@demostf/demo.js/build/DynamicBitStream");
const Message_1 = require("@demostf/demo.js/build/Data/Message");
const Parser_1 = require("@demostf/demo.js/build/Parser");
const Encoder_1 = require("@demostf/demo.js/build/Encoder");
function lerp(start, end, amount) {
    return start + (end - start) * amount;
}
function circleLerp(start, end, amount) {
    var shortestAngle = ((((end - start) % 360) + 540) % 360) - 180;
    return start + (shortestAngle * amount) % 360;
}
function interpEntity(start, end, amount) {
    var names = [
        "m_vecOrigin",
        "m_vecOrigin[2]",
        "m_angRotation",
        "m_angEyeAngles[0]",
        "m_angEyeAngles[1]",
        "m_angCustomModelRotation",
        "m_vecPunchAngle",
        "m_vecViewOffset[0]",
        "m_vecViewOffset[1]",
        "m_vecViewOffset[2]",
        "m_vecBaseVelocity",
        "m_vecVelocity[0]",
        "m_vecVelocity[1]",
        "m_vecVelocity[2]",
        "m_vecMins",
        "m_vecMaxs",
        "m_vecSpecifiedSurroundingMinsPreScaled",
        "m_vecSpecifiedSurroundingMaxsPreScaled",
        "m_vecSpecifiedSurroundingMins",
        "m_vecSpecifiedSurroundingMaxs",
        "m_vecMinsPreScaled",
        "m_vecMaxsPreScaled",
        "m_vecConstraintCenter",
        "m_vecCustomModelOffset",
        "m_vecForce",
    ];
    // numbers
    for (let prop1 of start.props) {
        if (!names.includes(prop1.definition.name))
            continue;
        if (typeof prop1.value !== "number")
            continue;
        for (let prop2 of end.props) {
            if (!names.includes(prop2.definition.name))
                continue;
            if (typeof prop2.value !== "number")
                continue;
            if (prop1.definition.name !== prop2.definition.name)
                continue;
            if (prop1.definition.table !== prop2.definition.table)
                continue;
            if (prop1.definition.ownerTableName !== prop2.definition.ownerTableName)
                continue;
            if (prop1.definition.bitCount !== prop2.definition.bitCount)
                continue;
            if (prop1.definition.flags !== prop2.definition.flags)
                continue;
            if (prop1.definition.lowValue === 0 && prop1.definition.highValue === 360) {
                // angles clamped to 0-360
                //console.log(`Circle: ${prop1.definition.name} (${prop1.value})`);
                prop1.value = circleLerp(prop1.value, prop2.value, amount);
            }
            else {
                //console.log(`Linear: ${prop1.definition.name} (${prop1.value})`);
                prop1.value = lerp(prop1.value, prop2.value, amount);
            }
        }
    }
    // vectors
    var keys = ["x", "y", "z"];
    for (let prop1 of start.props) {
        if (!names.includes(prop1.definition.name))
            continue;
        if (typeof prop1.value !== "object")
            continue;
        if (Object.keys(prop1.value).length !== 3)
            continue;
        var cont = false;
        for (var i = 0; i < keys.length; i++) {
            if (!Object.keys(prop1.value).includes(keys[i])) {
                cont = true;
                break;
            }
        }
        if (cont)
            continue;
        for (let prop2 of end.props) {
            if (!names.includes(prop2.definition.name))
                continue;
            if (typeof prop2.value !== "object")
                continue;
            if (Object.keys(prop2.value).length !== 3)
                continue;
            for (var i = 0; i < keys.length; i++) {
                if (!Object.keys(prop2.value).includes(keys[i])) {
                    cont = true;
                    break;
                }
            }
            if (cont)
                continue;
            if (prop1.definition.name !== prop2.definition.name)
                continue;
            if (prop1.definition.table !== prop2.definition.table)
                continue;
            if (prop1.definition.ownerTableName !== prop2.definition.ownerTableName)
                continue;
            if (prop1.definition.bitCount !== prop2.definition.bitCount)
                continue;
            if (prop1.definition.flags !== prop2.definition.flags)
                continue;
            for (const key of keys) {
                prop1.value[key] = lerp(prop1.value[key], prop2.value[key], amount);
            }
        }
    }
    return start;
}
function incrementEntityTicks(entity, amount) {
    var names = [
        "m_nTickBase",
        "m_flSimulationTime"
    ];
    for (let prop of entity.props) {
        if (names.includes(prop.definition.name)) {
            prop.value = prop.value + amount;
        }
    }
    return entity;
}
class InterpTransformer extends Parser_1.Parser {
    constructor(sourceStream, targetStream) {
        super(sourceStream);
        this.encoder = new Encoder_1.Encoder(targetStream);
    }
    writeMessage(message) {
        this.parserState.handleMessage(message);
        if (message.type === Message_1.MessageType.Packet) {
            for (const packet of message.packets) {
                this.parserState.handlePacket(packet);
            }
        }
        this.encoder.writeMessage(message);
    }
    transform() {
        const header = this.getHeader();
        header.frames *= 4;
        //console.log(header);
        this.encoder.encodeHeader(header);
        var prevProgressPrint = 0;
        var prevPacketMessage = null;
        var synced = false;
        var skippedFirst = false;
        for (let message of this.iterateMessages()) {
            if (message.type === Message_1.MessageType.SyncTick) {
                // <Header>
                // <Packet>
                // <DataTables>
                // <StringTables>
                // <Packet>
                // <Packet>
                // <SyncTick>
                // <Packet>     | tick 4, the fat network packet - probably contains initial states of everything
                // <Packet>     | tick 8, delta packets start here?; i think we only want to manipulate these ones
                // ...
                // <Stop>
                synced = true;
            }
            if (synced && skippedFirst && message.type === Message_1.MessageType.Packet) {
                if (prevPacketMessage) {
                    message.sequenceIn = prevPacketMessage.sequenceIn + 4;
                    message.sequenceOut = prevPacketMessage.sequenceOut + 4;
                    prevPacketMessage.packets = prevPacketMessage.packets.filter((value, index, arr) => {
                        //if (!["netTick", "packetEntities"].includes(value.packetType)) console.log(`REMOVING ${value.packetType}`);
                        return ["netTick", "packetEntities"].includes(value.packetType);
                    });
                    for (let i = 0; i < 3; i++) {
                        prevPacketMessage.tick++;
                        prevPacketMessage.sequenceIn++;
                        prevPacketMessage.sequenceOut++;
                        for (let packet of prevPacketMessage.packets) {
                            // FIXME: chat messages are duplicated 4 times,
                            // should probably remove chat packets here.
                            // Figure out if we can remove other types too.
                            if (packet.packetType === "netTick") {
                                packet.tick++;
                                continue;
                            }
                            if (packet.packetType === "packetEntities") {
                                for (let entity of packet.entities) {
                                    // if (entity.entityIndex > 64) {
                                    //     // max players
                                    //     break;
                                    // }
                                    // if (entity.serverClass.name !== "CTFPlayer") {
                                    //     continue;
                                    // }
                                    // Loop through new message and interp
                                    for (let newPacket of message.packets) {
                                        if (newPacket.packetType !== "packetEntities") {
                                            continue;
                                        }
                                        for (let newEntity of newPacket.entities) {
                                            // if (newEntity.entityIndex > 64) {
                                            //     // max players
                                            //     break;
                                            // }
                                            // if (newEntity.serverClass.name !== "CTFPlayer") {
                                            //     continue;
                                            // }
                                            if (newEntity.entityIndex !== entity.entityIndex) {
                                                continue;
                                            }
                                            // We interpolate same entity multiple times,
                                            // edit interp amount appropriately.
                                            // TODO: figure out formula for this...
                                            // 0    -> 0.25 = 0.25
                                            // 0.25 -> 0.5  = 1/3
                                            // 0.5  -> 0.75 = 0.5
                                            var interp = 0.25;
                                            if (i == 1)
                                                interp = 1 / 3;
                                            else if (i == 2)
                                                interp = 0.5;
                                            entity = interpEntity(entity, newEntity, interp);
                                            entity = incrementEntityTicks(entity, 1);
                                            newEntity = incrementEntityTicks(newEntity, 1);
                                        }
                                    }
                                }
                            }
                        }
                        //console.log(`interp tick: ${prevPacketMessage.tick}, in: ${prevPacketMessage.sequenceIn}, out: ${prevPacketMessage.sequenceOut}`);
                        this.writeMessage(prevPacketMessage);
                    }
                }
                prevPacketMessage = message;
                if (message.tick > prevProgressPrint + 10000) {
                    prevProgressPrint += 10000;
                    console.log(`Progress: ${message.tick} / ${header.ticks}`);
                }
            }
            if (synced && !skippedFirst && message.type === Message_1.MessageType.Packet) {
                // Skip first packet
                skippedFirst = true;
            }
            // if (message.type === MessageType.Packet) {
            //     console.log(`tick: ${message.tick}, in: ${message.sequenceIn}, out: ${message.sequenceOut}`);
            // }
            // Write current message
            this.writeMessage(message);
        }
    }
}
/**
 * Interpolate demo files by filling out the gaps between Packets.
 * @param input - Input demofile name
 * @param output - Output demofile name
 */
function interp(input, output) {
    const decodeStream = new bit_buffer_1.BitStream(fs_1.readFileSync(input).buffer);
    const encodeStream = new DynamicBitStream_1.DynamicBitStream(32 * 1024 * 1024);
    const transformer = new InterpTransformer(decodeStream, encodeStream);
    transformer.transform();
    const encodedLength = encodeStream.index;
    encodeStream.index = 0;
    fs_1.writeFileSync(output, encodeStream.readArrayBuffer(Math.ceil(encodedLength / 8)));
}
exports.interp = interp;
//# sourceMappingURL=index.js.map