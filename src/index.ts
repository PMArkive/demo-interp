import { BitStream } from "bit-buffer";
import { readFileSync, writeFileSync } from "fs";
import { DynamicBitStream } from "@demostf/demo.js/build/DynamicBitStream";
import { Message, MessageType, PacketMessage } from "@demostf/demo.js/build/Data/Message";
import { Parser } from "@demostf/demo.js/build/Parser";
import { Encoder } from "@demostf/demo.js/build/Encoder";
import { PacketEntity } from "@demostf/demo.js/build/Data/PacketEntity";

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function circleLerp(start: number, end: number, amount: number) {
  var shortestAngle = ((((end - start) % 360) + 540) % 360) - 180;
  return start + ((shortestAngle * amount) % 360);
}

function interpNumber(start: number, end: number, amount: number, lowValue: number, highValue: number) {
  if (lowValue === 0 && highValue === 360) {
    // angles clamped to 0-360
    start = circleLerp(start, end, amount);
  } else {
    start = lerp(start, end, amount);
  }
  return start;
}

// Props to interpolate,
// most of these are probably not needed
const propNames = [
  // These are in a bunch of tables
  "m_vecOrigin",

  // DT_BaseEntity
  "m_angRotation",
  "m_flElasticity",
  "m_flShadowCastDistance",

  // DT_BaseAnimating
  "m_vecForce",
  "m_flModelScale",
  "m_flFadeScale",

  // DT_BasePlayer
  "m_flMaxspeed",
  "m_flFOVTime",

  // DT_TFLocalPlayerExclusive
  // DT_TFNonLocalPlayerExclusive
  "m_vecOrigin[2]",
  "m_angEyeAngles[0]",
  "m_angEyeAngles[1]",

  // DT_LocalPlayerExclusive
  "m_vecViewOffset[0]",
  "m_vecViewOffset[1]",
  "m_vecViewOffset[2]",
  "m_vecBaseVelocity",
  "m_vecVelocity[0]",
  "m_vecVelocity[1]",
  "m_vecVelocity[2]",

  // DT_LOCAL
  "m_flDucktime",
  "m_flJumpTime",
  "m_flDuckJumpTime",
  "m_flFallVelocity",
  "m_flNextAttack",
  "m_vecPunchAngle",
  "m_vecPunchAngleVel",

  // DT_TFPlayerShared
  "m_flDuckTimer",
  "m_flMovementStunTime",
  "m_flFirstPrimaryAttack",
  "m_flEnergyDrinkMeter",
  "m_flHypeMeter",
  "m_flChargeMeter",
  "m_flInvisChangeCompleteTime",
  "m_flCloakMeter",
  "m_flSpyTranqBuffDuration",
  "m_flRuneCharge",
  "m_flHolsterAnimTime",

  // DT_CollisionProperty
  "m_vecMins",
  "m_vecMaxs",
  "m_vecMinsPreScaled",
  "m_vecMaxsPreScaled",
  "m_vecSpecifiedSurroundingMins",
  "m_vecSpecifiedSurroundingMaxs",
  "m_vecSpecifiedSurroundingMinsPreScaled",
  "m_vecSpecifiedSurroundingMaxsPreScaled",
];

const vecKeys = ["x", "y", "z"];
const EF_NOINTERP = 8;

function interpEntity(start: PacketEntity, end: PacketEntity, amount: number): PacketEntity {
  for (let prop1 of start.props) {
    if (!propNames.includes(prop1.definition.name)) continue;

    for (let prop2 of end.props) {
      if (!propNames.includes(prop2.definition.name)) continue;
      if (prop1.definition.fullName !== prop2.definition.fullName) continue;

      if (typeof prop1.value === "number") {
        prop1.value = interpNumber(
          prop1.value as number,
          prop2.value as number,
          amount,
          prop1.definition.lowValue,
          prop1.definition.highValue
        );
        break;
      }

      // Interp vectors
      if (typeof prop1.value === "object") {
        if (Object.keys(prop1.value).length !== 3) continue;
        if (Object.keys(prop2.value).length !== 3) continue;

        // Check x,y,z keys
        var cont = false;
        for (const key of vecKeys) {
          if (
            !Object.keys(prop1.value).includes(key) ||
            !Object.keys(prop2.value).includes(key) ||
            typeof prop1.value[key] !== "number" ||
            typeof prop2.value[key] !== "number"
          ) {
            cont = true;
            break;
          }
        }
        if (cont) continue;

        for (const key of vecKeys) {
          prop1.value[key] = interpNumber(
            prop1.value[key] as number,
            prop2.value[key] as number,
            amount,
            prop1.definition.lowValue,
            prop1.definition.highValue
          );
        }
        break;
      }
    }
  }

  return start;
}

function incrementEntityTicks(entity: PacketEntity, amount: number): PacketEntity {
  var names = ["m_nTickBase", "m_flSimulationTime"];
  for (let prop of entity.props) {
    if (names.includes(prop.definition.name)) {
      prop.value = (prop.value as number) + amount;
    }
  }
  return entity;
}

class InterpTransformer extends Parser {
  private readonly encoder: Encoder;
  private readonly maxVel: number;

  constructor(sourceStream: BitStream, targetStream: BitStream, maxVel: number = 3500) {
    super(sourceStream);
    this.encoder = new Encoder(targetStream);
    this.maxVel = maxVel;
  }

  writeMessage(message: Message) {
    this.parserState.handleMessage(message);
    if (message.type === MessageType.Packet) {
      for (const packet of message.packets) {
        this.parserState.handlePacket(packet);
      }
    }

    this.encoder.writeMessage(message);
  }

  public transform() {
    const header = this.getHeader();
    header.frames *= 4;
    this.encoder.encodeHeader(header);

    var prevProgressPrint = 0;
    var prevPacketMessage = null;
    var synced = false;
    var skippedFirst = false;
    var lastKnownProps = {};
    var tickInterval = 0.015;

    for (let message of this.iterateMessages()) {
      if (message.type === MessageType.SyncTick) {
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

      if (synced && skippedFirst && message.type === MessageType.Packet) {
        if (prevPacketMessage) {
          message.sequenceIn = prevPacketMessage.sequenceIn + 4;
          message.sequenceOut = prevPacketMessage.sequenceOut + 4;

          prevPacketMessage.packets = prevPacketMessage.packets.filter((value, index, arr) => {
            return ["netTick", "packetEntities"].includes(value.packetType);
          });

          // Packets only contain props if they change during that tick,
          // store last known props and restore previously stored ones.
          for (let p of prevPacketMessage.packets) {
            if (p.packetType !== "packetEntities") {
              continue;
            }

            for (let e of p.entities as PacketEntity[]) {
              if (p.removedEntities.includes(e.entityIndex)) {
                //console.log("packet includes removed ent");
                delete lastKnownProps[`${e.entityIndex}:${e.serverClass.id}`];
              }

              // Store from entity
              for (const prop of e.props) {
                if (!propNames.includes(prop.definition.name)) continue;

                // Using just entityIndex will sometimes fail
                // for some reason, maybe they are recycled.
                // This happens even with the newPacket.removedEntities check
                // later on...
                if (lastKnownProps[`${e.entityIndex}:${e.serverClass.id}`] == null) {
                  lastKnownProps[`${e.entityIndex}:${e.serverClass.id}`] = {};
                }
                lastKnownProps[`${e.entityIndex}:${e.serverClass.id}`][prop.definition.fullName] = prop;
              }

              // Restore props later on after checking what props the future entities have
            }
          }

          // Add 3 intepolated ticks
          for (let i = 0; i < 3; i++) {
            prevPacketMessage.tick++;
            prevPacketMessage.sequenceIn++;
            prevPacketMessage.sequenceOut++;

            for (let packet of prevPacketMessage.packets) {
              if (packet.packetType === "netTick") {
                packet.tick++;
                tickInterval = packet.frameTime / 100000;
                continue;
              }

              // packetEntities
              for (let entity of packet.entities as PacketEntity[]) {
                // Loop through new message and interp
                for (let newPacket of message.packets) {
                  if (newPacket.packetType !== "packetEntities") {
                    continue;
                  }

                  for (const index of newPacket.removedEntities) {
                    for (let propIndex = Object.keys(lastKnownProps).length - 1; propIndex > 0; propIndex--) {
                      if (Object.keys(lastKnownProps)[propIndex].startsWith(index.toString() + ":")) {
                        delete lastKnownProps[Object.keys(lastKnownProps)[propIndex]];
                      }
                    }
                  }

                  if (newPacket.removedEntities.includes(entity.entityIndex)) {
                    continue;
                  }

                  for (let newEntity of newPacket.entities) {
                    if (newEntity.entityIndex !== entity.entityIndex) {
                      continue;
                    }

                    if (newEntity.serverClass.id !== entity.serverClass.id) {
                      continue;
                    }

                    entity = incrementEntityTicks(entity, 1);
                    newEntity = incrementEntityTicks(newEntity, 1);

                    // Don't interp if new entity has EF_NOINTERP flag
                    var m_fEffects = newEntity.getPropValue("DT_BaseEntity.m_fEffects");
                    if (m_fEffects !== null) {
                      if (((m_fEffects as number) & EF_NOINTERP) === EF_NOINTERP) {
                        break;
                      }
                    }

                    // Check for maxVel
                    if (lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`] != null) {
                      var lastOrigin = null;
                      var lastOriginZ = null;
                      var newOrigin = null;
                      var newOriginZ = null;

                      for (const p of newEntity.props) {
                        if (p.definition.name === "m_vecOrigin") {
                          newOrigin = p.value;
                          if (lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`][p.definition.fullName] != null) {
                            lastOrigin = lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`][p.definition.fullName].value;
                          }
                        } else if (p.definition.name === "m_vecOrigin[2]") {
                          newOriginZ = p.value;
                          if (lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`][p.definition.fullName] != null) {
                            lastOriginZ = lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`][p.definition.fullName].value;
                          }
                        }
                      }

                      if (lastOrigin != null && newOrigin != null) {
                        if (lastOriginZ) {
                          lastOrigin.z = lastOriginZ;
                        }
                        if (newOriginZ) {
                          newOrigin.z = newOriginZ;
                        }

                        for (let axis of vecKeys) {
                          var dist = newOrigin[axis] - lastOrigin[axis];
                          if (dist > this.maxVel * tickInterval * 4) {
                            //console.log(`Entity ${newEntity.serverClass.name} (${newEntity.entityIndex}) moved over maxvel (${dist} > ${this.maxVel * tickInterval * 4})`);
                            break;
                          }
                        }
                      }
                    }

                    // Restore from previously stored props only the props
                    // that the future entity has, so we can interp between them.
                    // Only need to do this the first time,
                    // since we reuse the message.
                    if (i < 0) {
                      if (lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`] != null) {
                        var propArr = [];

                        for (const propKey of Object.keys(lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`])) {
                          // Check if new entity has this property,
                          // if not, no need to add it to the old entity for interpolation.
                          if (newEntity.hasProperty(propKey.split(".")[0], propKey.split(".")[1])) {
                            propArr.push(lastKnownProps[`${entity.entityIndex}:${entity.serverClass.id}`][propKey]);
                          }
                        }

                        if (propArr.length > 0) {
                          //console.log(`Applying ${propArr.length} props`);
                          entity.applyPropUpdate(propArr);
                        }
                      }
                    }

                    // We interpolate same entity multiple times,
                    // edit interp amount appropriately.
                    // min      target      max         interp
                    // 0        0.25        1.0         0.25
                    // 0.25     0.5         1.0         1/3
                    // 0.5      0.75        1.0         0.5
                    var interp = 0.25 * (1 / (1 - 0.25 * i));

                    entity = interpEntity(entity, newEntity, interp);
                  }
                }
              }
            }

            this.writeMessage(prevPacketMessage);
          }
        }

        prevPacketMessage = message;

        if (message.tick > prevProgressPrint + 10000) {
          prevProgressPrint += 10000;
          console.log(`Progress: ${message.tick} / ${header.ticks}`);
        }
      }

      if (synced && !skippedFirst && message.type === MessageType.Packet) {
        // Skip first packet
        skippedFirst = true;
      }

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
function interp(input: string, output: string, maxVel: number = 3500) {
  const decodeStream = new BitStream(readFileSync(input).buffer as ArrayBuffer);
  const encodeStream = new DynamicBitStream(32 * 1024 * 1024);

  const transformer = new InterpTransformer(decodeStream, encodeStream, maxVel);
  transformer.transform();

  const encodedLength = encodeStream.index;
  encodeStream.index = 0;

  writeFileSync(output, encodeStream.readArrayBuffer(Math.ceil(encodedLength / 8)));
}

export { interp };
