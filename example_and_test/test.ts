/**
 * These are unit tests for bdsx
 */

import { Actor, bin, CANCEL, MinecraftPacketIds, NativePointer, NetworkIdentifier, serverInstance } from "bdsx";
import { asm, FloatRegister, OperationSize, Register } from "bdsx/assembler";
import { ActorType, DimensionId } from "bdsx/bds/actor";
import { CommandContext } from "bdsx/bds/command";
import { HashedString } from "bdsx/bds/hashedstring";
import { networkHandler } from "bdsx/bds/networkidentifier";
import { AttributeData, PacketIdToType } from "bdsx/bds/packets";
import { proc2 } from "bdsx/bds/symbols";
import { capi } from "bdsx/capi";
import { CxxVector } from "bdsx/cxxvector";
import { disasm } from "bdsx/disassembler";
import { dll } from "bdsx/dll";
import { events } from "bdsx/event";
import { HashSet } from "bdsx/hashset";
import { bedrockServer } from "bdsx/launcher";
import { nativeClass, NativeClass, nativeField } from "bdsx/nativeclass";
import { bin64_t, bool_t, CxxString, float32_t, float64_t, int16_t, int32_t, uint16_t } from "bdsx/nativetype";
import { CxxStringWrapper } from "bdsx/pointer";
import { PseudoRandom } from "bdsx/pseudorandom";
import { Tester } from "bdsx/tester";
import { hex } from "bdsx/util";

let sendidcheck = 0;
let nextTickPassed = false;
let chatCancelCounter = 0;

export function setRecentSendedPacketForTest(packetId: number): void {
    sendidcheck = packetId;
}

Tester.test({
    async globals() {
        this.assert(!!serverInstance && serverInstance.isNotNull(), 'serverInstance not found');
        this.assert(serverInstance.vftable.equals(proc2['??_7ServerInstance@@6BEnableNonOwnerReferences@Bedrock@@@']),
            'serverInstance is not ServerInstance');
        this.assert(!!networkHandler && networkHandler.isNotNull(), 'networkHandler not found');
        this.assert(networkHandler.vftable.equals(proc2['??_7NetworkHandler@@6BIGameConnectionInfoProvider@Social@@@']),
            'networkHandler is not NetworkHandler');
        const inst = networkHandler.instance;
        this.assert(!!inst && inst.isNotNull(), 'RaknetInstance not found');
        this.assert(inst.vftable.equals(proc2["??_7RakNetInstance@@6BConnector@@@"]),
            'networkHandler.instance is not RaknetInstance');

        const rakpeer = inst.peer;
        this.assert(!!rakpeer && rakpeer.isNotNull(), 'RakNet::RakPeer not found');;
        this.assert(rakpeer.vftable.equals(proc2["??_7RakPeer@RakNet@@6BRakPeerInterface@1@@"]),
            'networkHandler.instance.peer is not RakNet::RakPeer');

        this.assert(serverInstance.scriptEngine.vftable.equals(proc2['??_7MinecraftServerScriptEngine@@6BScriptFramework@ScriptApi@@@']),
            'serverInstance.scriptEngine is not ScriptFrameWork');

        this.assert(serverInstance.scriptEngine.scriptEngineVftable.equals(proc2['??_7MinecraftServerScriptEngine@@6B@']),
            'serverInstance.scriptEngine wrong vftable offset');
    },

    async nexttick() {
        nextTickPassed = await Promise.race([
            new Promise<boolean>(resolve => process.nextTick(() => resolve(true))),
            new Promise<boolean>(resolve => setTimeout(() => {
                if (nextTickPassed) return;
                this.fail();
                resolve(false);
            }, 1000))
        ]);
    },

    disasm() {
        const assert = (hexcode: string, asmcode: string, nonsamehex:boolean = false) => {
            const opers = disasm.check(hexcode, true);
            const disasem = opers.toString().replace(/\n/g, ';');
            this.equals(disasem, asmcode, ``);
            if (!nonsamehex) this.equals(hex(opers.asm().buffer()), hexcode.toUpperCase());
        };

        assert('f3 0f 11 89 a4 03 00 00', 'movss dword ptr [rcx+0x3a4], xmm1');
        assert('0F 84 7A 06 00 00 55 56 57 41 54 41 55 41 56', 'je 0x67a;push rbp;push rsi;push rdi;push r12;push r13;push r14');
        assert('80 79 48 00 74 18 48 83 C1 38', 'cmp byte ptr [rcx+0x48], 0x0;je 0x18;add rcx, 0x38');
        assert('48 8B D9', 'mov rbx, rcx', true);
        assert('0F 29 74 24 20 E8 8D 0D FE FF', 'movaps xmmword ptr [rsp+0x20], xmm6;call -0x1f273');
        assert('49 8B D8', 'mov rbx, r8', true);
        assert('48 8d 40 01', 'lea rax, qword ptr [rax+0x1]');
        assert('0F 10 02 48 8D 59 08 48 8D 54 24 20', 'movups xmm0, xmmword ptr [rdx];lea rbx, qword ptr [rcx+0x8];lea rdx, qword ptr [rsp+0x20]');
        assert('48 8B CB', 'mov rcx, rbx', true);
        assert('0F 10 02', 'movups xmm0, xmmword ptr [rdx]');
        assert('48 0f b6 c1', 'movzx rax, cl');
        assert('0f b6 c1', 'movzx eax, cl');
        assert('0f b7 c0', 'movzx eax, ax');
        assert('0f b6 c0', 'movzx eax, al');
        assert('0f bf c0', 'movsx eax, ax');
        assert('0f be 00', 'movsx eax, byte ptr [rax]');
        assert('44 0F B6 C1 49 BA B3 01 00 00 00 01 00 00', 'movzx r8d, cl;movabs r10, 0x100000001b3');
    },

    bin() {
        this.equals(bin.make64(1, 0), bin64_t.one, 'bin.make64(1, 0)', bin.toString);
        this.equals(bin.make64(0, 0), bin64_t.zero, 'bin.make64(0, 0)', bin.toString);
        this.equals(bin.make64(-1, -1), bin64_t.minus_one, 'bin.make64(-1, -1)', bin.toString);
        const small = bin.make64(0x100, 0);
        this.equals(small, '\u0100\0\0\0', 'bin.make64(0x100, 0)', bin.toString);
        const big = bin.make64(0x10002, 0);
        this.equals(big, '\u0002\u0001\0\0', 'bin.make64(0x10002, 0)', bin.toString);
        this.equals(bin.sub(big, small), '\uff02\0\0\0', 'bin.sub()', bin.toString);
        const big2 = bin.add(big, bin.add(big, small));
        this.equals(big2, '\u0104\u0002\0\0', 'bin.add()', bin.toString);
        const bigbig = bin.add(bin.add(bin.muln(big2, 0x100000000), small), bin64_t.one);
        this.equals(bigbig, '\u0101\u0000\u0104\u0002', 'bin.muln()', bin.toString);
        const dived = bin.divn(bigbig, 2);
        this.equals(dived[0], '\u0080\u0000\u0082\u0001', 'bin.divn()', bin.toString);
        this.equals(dived[1], 1, 'bin.divn()');
        this.equals(bin.toString(dived[0], 16), '1008200000080', 'bin.toString()');

        const ptr = capi.malloc(10);
        try {
            const bignum = bin.makeVar(123456789012345);
            ptr.add().writeVarBin(bignum);
            this.equals(ptr.add().readVarBin(), bignum, 'writevarbin / readvarbin', bin.toString);
        } finally {
            capi.free(ptr);
        }

        this.equals(bin.bitshl('\u1000\u0100\u0010\u1001', 0), '\u1000\u0100\u0010\u1001', 'bin.bitshl(0)', v=>bin.toString(v, 16));
        this.equals(bin.bitshr('\u1001\u0100\u0010\u0001', 0), '\u1001\u0100\u0010\u0001', 'bin.bitshr(0)', v=>bin.toString(v, 16));
        this.equals(bin.bitshl('\u1000\u0100\u0010\u1001', 4), '\u0000\u1001\u0100\u0010', 'bin.bitshl(4)', v=>bin.toString(v, 16));
        this.equals(bin.bitshr('\u1001\u0100\u0010\u0001', 4), '\u0100\u0010\u1001\u0000', 'bin.bitshr(4)', v=>bin.toString(v, 16));
        this.equals(bin.bitshl('\u1000\u0100\u0010\u1001', 16), '\u0000\u1000\u0100\u0010', 'bin.bitshl(16)', v=>bin.toString(v, 16));
        this.equals(bin.bitshr('\u1001\u0100\u0010\u0001', 16), '\u0100\u0010\u0001\u0000', 'bin.bitshr(16)', v=>bin.toString(v, 16));
        this.equals(bin.bitshl('\u1000\u0100\u0010\u1001', 20), '\u0000\u0000\u1001\u0100', 'bin.bitshl(20)', v=>bin.toString(v, 16));
        this.equals(bin.bitshr('\u1001\u0100\u0010\u0001', 20), '\u0010\u1001\u0000\u0000', 'bin.bitshr(20)', v=>bin.toString(v, 16));
    },

    hashset() {
        class HashItem {
            constructor(public readonly value: number) {
            }

            hash(): number {
                return this.value;
            }

            equals(other: HashItem): boolean {
                return this.value === other.value;
            }
        }

        const TEST_COUNT = 200;

        const values: number[] = [];
        const n = new PseudoRandom(12345);
        const hashset = new HashSet<HashItem>();
        let count = 0;
        for (const v of hashset.entires()) {
            count++;
        }
        if (count !== 0) this.error(`empty hashset is not empty`);
        for (let i = 0; i < TEST_COUNT;) {
            const v = n.rand() % 100;
            values.push(v);
            hashset.add(new HashItem(v));

            i++;
        }

        for (const v of values) {
            if (!hashset.has(new HashItem(v))) {
                this.error(`hashset.has failed, item not found ${v}`);
                continue;
            }
            if (!hashset.delete(new HashItem(v))) {
                this.error(`hashset.delete failed ${v}`);
                continue;
            }
        }
        if (hashset.size !== 0) {
            this.error(`cleared hashset is not cleared: ${hashset.size}`);
        }
        for (let i = 0; i < 200; i++) {
            const v = n.rand() % 100;
            if (hashset.has(new HashItem(v))) {
                this.error('hashset.has failed, found on empty');
            }
        }

    },

    memset(): void {
        const dest = new Uint8Array(12);
        const ptr = new NativePointer;
        ptr.setAddressFromBuffer(dest);
        dll.vcruntime140.memset(ptr, 1, 12);
        for (const v of dest) {
            this.equals(v, 1, 'wrong value: ' + v);
        }
    },

    cxxstring() {
        const str = new CxxStringWrapper(true);
        str.construct();
        this.equals(str.length, 0, 'std::string invalid constructor');
        this.equals(str.capacity, 15, 'std::string invalid constructor');
        const shortcase = '111';
        const longcase = '123123123123123123123123';
        str.value = shortcase;
        this.equals(str.value, shortcase, 'failed with short text');
        str.value = longcase;
        this.equals(str.value, longcase, 'failed with long text');
        str.destruct();

        const hstr = new HashedString(true);
        hstr.construct();
        this.equals(hstr.str, '', 'Invalid string');
        hstr.destruct();

        const data = new AttributeData(true);
        data.construct();
        this.equals(data.name.str, '', 'Invalid string');
        data.destruct();
    },

    makefunc() {
        const test = asm().mov_rp_c(Register.rcx, 1, 0, 1, OperationSize.dword).mov_r_r(Register.rax, Register.rcx).ret().make(int32_t, {structureReturn:true});
        this.equals(test(), 1, 'structureReturn int32_t');
        const floatToDouble = asm().cvtss2sd_f_f(FloatRegister.xmm0, FloatRegister.xmm0).ret().make(float64_t, null, float32_t);
        this.equals(floatToDouble(123), 123, 'float to double');
        const doubleToFloat = asm().cvtsd2ss_f_f(FloatRegister.xmm0, FloatRegister.xmm0).ret().make(float32_t, null, float64_t);
        this.equals(doubleToFloat(123), 123, 'double to float');
        const getbool = asm().mov_r_c(Register.rax, 0x100).ret().make(bool_t);
        this.equals(getbool(), false, 'bool return');
        const bool2int = asm().mov_r_r(Register.rax, Register.rcx).ret().make(int32_t, null, bool_t);
        this.equals(bool2int(true), 1, 'bool to int');
        const int2short_as_int = asm().movzx_r_r(Register.rax, Register.rcx, OperationSize.dword, OperationSize.word).ret().make(int32_t, null, int32_t);
        this.equals(int2short_as_int(-1), 0xffff, 'int to short old');
        const int2short = asm().movzx_r_r(Register.rax, Register.rcx, OperationSize.dword, OperationSize.word).ret().make(int16_t, null, int32_t);
        this.equals(int2short(-1), -1, 'int to short');
        this.equals(int2short(0xffff), -1, 'int to short');
        const int2ushort = asm().movzx_r_r(Register.rax, Register.rcx, OperationSize.dword, OperationSize.word).ret().make(uint16_t, null, int32_t);
        this.equals(int2ushort(-1), 0xffff, 'int to ushort');
        this.equals(int2ushort(0xffff), 0xffff, 'int to ushort');
        const string2string = asm().mov_r_r(Register.rax, Register.rcx).ret().make(CxxString, null, CxxString);
        this.equals(string2string('test'), 'test', 'string to string');
        this.equals(string2string('testtesta'), 'testtesta', 'test string over 8 bytes');
        this.equals(string2string('test string over 15 bytes'), 'test string over 15 bytes', 'string to string');
        const nullreturn = asm().xor_r_r(Register.rax, Register.rax).ret().make(NativePointer);
        this.equals(nullreturn(), null, 'nullreturn does not return null');
    },

    vectorcopy() {
        @nativeClass()
        class Class extends NativeClass {
            @nativeField(CxxVector.make(CxxString))
            vector:CxxVector<CxxString>;
            @nativeField(CxxVector.make(CxxStringWrapper))
            vector2:CxxVector<CxxStringWrapper>;
        }

        const a = new Class(true);
        a.construct();
        a.vector.push('test');
        const str = new CxxStringWrapper(true);
        str.construct();
        str.value = 'test2';
        a.vector2.push(str);
        str.destruct();

        this.equals(a.vector.size(), 1, 'a.vector, invalid size');
        this.equals(a.vector2.size(), 1, 'a.vector2, invalid size');
        this.equals(a.vector.get(0), 'test', `a.vector, invalid value ${a.vector.get(0)}`);
        this.equals(a.vector2.get(0)!.value, 'test2', `a.vector2, invalid value ${a.vector2.get(0)!.value}`);

        const b = new Class(true);
        b.construct(a);
        this.equals(b.vector.size(), 1, 'b.vector, invalid size');
        this.equals(b.vector2.size(), 1, 'b.vector2, invalid size');
        this.equals(b.vector.get(0), 'test', `b.vector, invalid value ${b.vector.get(0)}`);
        this.equals(b.vector2.get(0)!.value, 'test2', `b.vector2, invalid value ${b.vector2.get(0)!.value}`);
        b.vector.get(0);

        b.destruct();

        a.destruct();
    },

    async command() {
        let passed = false;
        const cb = (cmd:string, origin:string, ctx:CommandContext) => {
            if (cmd === '/__dummy_command') {
                passed = origin === 'Server';
                this.equals(ctx.origin.getDimension(), null, 'dimension id');
                const pos = ctx.origin.getWorldPosition();
                this.assert(pos.x === 0 && pos.y === 0 && pos.z === 0, 'world pos is not zero');
                const actor = ctx.origin.getEntity();
                this.assert(actor === null, `origin.getEntity() is not null. result = ${actor}`);
                const size = ctx.origin.getLevel().players.size();
                this.assert(size === 0, 'origin.getLevel().players.size is not zero');
                events.command.remove(cb);
            }
        };
        events.command.on(cb);
        await new Promise<void>((resolve) => {
            const outputcb = (output:string) => {
                if (output.startsWith('Unknown command: __dummy_command')) {
                    events.commandOutput.remove(outputcb);
                    if (passed) resolve();
                    else this.fail();
                    return CANCEL;
                }
            };
            events.commandOutput.on(outputcb);
            bedrockServer.executeCommandOnConsole('__dummy_command');
        });
    },

    async command2() {
        let passed = false;
        const cb = (cmd:string, origin:string) => {
            if (cmd === '/__dummy_command') {
                passed = origin === 'Server';
                events.command.remove(cb);
            }
        };
        events.command.on(cb);
        await new Promise<void>((resolve) => {
            const outputcb = (output:string) => {
                if (output.startsWith('Unknown command: __dummy_command')) {
                    events.commandOutput.remove(outputcb);
                    if (passed) resolve();
                    else this.fail();
                    return CANCEL;
                }
            };
            events.commandOutput.on(outputcb);
            bedrockServer.executeCommand('/__dummy_command', false);
        });
    },

    async checkPacketNames() {
        if (capi.isRunningOnWine()) {
            this.skip('Skip packet check on the Wine system, as it usually fails');
            return;
        }
        for (const id in PacketIdToType) {
            const Packet = PacketIdToType[+id as keyof PacketIdToType];
            const packet = Packet.create();

            const cxxname = packet.getName();
            let name = Packet.name;

            this.equals(cxxname, name);
            this.equals(packet.getId(), Packet.ID);

            const idx = name.lastIndexOf('Packet');
            if (idx !== -1) name = name.substr(0, idx) + name.substr(idx+6);
            this.equals(MinecraftPacketIds[Packet.ID], name);

            packet.dispose();
        }

        for (const id in MinecraftPacketIds) {
            if (!/^[0-9]+$/.test(id)) continue;
            const Packet = PacketIdToType[+id as keyof PacketIdToType];
            this.assert(!!Packet, `MinecraftPacketIds.${MinecraftPacketIds[id]}: class not found`);
        }
    },

    packetEvents() {
        let idcheck = 0;
        let sendpacket = 0;
        for (let i = 0; i < 255; i++) {
            events.packetRaw(i).on((ptr, size, ni, packetId) => {
                idcheck = packetId;
                this.assert(size > 0, `packet is too small (< 0)`);
                this.equals(packetId, (ptr.readVarUint() & 0x3ff), `different packetId in buffer. id=${packetId}`);
            });
            events.packetBefore<MinecraftPacketIds>(i).on((ptr, ni, packetId) => {
                this.equals(packetId, idcheck, `different packetId on before. id=${packetId}`);
                this.equals(ptr.getId(), idcheck, `different class.packetId on before. id=${packetId}`);
            });
            events.packetAfter<MinecraftPacketIds>(i).on((ptr, ni, packetId) => {
                this.equals(packetId, idcheck, `different packetId on after. id=${packetId}`);
                this.equals(ptr.getId(), idcheck, `different class.packetId on after. id=${packetId}`);
            });
            events.packetSend<MinecraftPacketIds>(i).on((ptr, ni, packetId) => {
                sendidcheck = packetId;
                this.equals(ptr.getId(), packetId, `different class.packetId on send. id=${packetId}`);
                sendpacket++;
            });
            events.packetSendRaw(i).on((ptr, size, ni, packetId) => {
                this.assert(size > 0, `packet size is too little`);
                this.equals(packetId, sendidcheck, `different packetId on sendRaw. id=${packetId}`);
                this.equals(packetId, (ptr.readVarUint() & 0x3ff), `different packetId in buffer. id=${packetId}`);
                sendpacket++;
            });
        }

        const conns = new Set<NetworkIdentifier>();
        events.packetAfter(MinecraftPacketIds.Login).on((ptr, ni) => {
            this.assert(!conns.has(ni), '[test] login without connection');
            conns.add(ni);
            setTimeout(() => {
                if (sendpacket === 0) {
                    this.error('[test] no packet was sent');
                }
            }, 1000);
        });
        events.networkDisconnected.on(ni => {
            this.assert(conns.delete(ni), '[test] disconnection without connection');
        });
    },

    actor() {
        const system = server.registerSystem(0, 0);
        system.listenForEvent('minecraft:entity_created', ev => {
            try {
                const uniqueId = ev.data.entity.__unique_id__;
                const actor = Actor.fromEntity(ev.data.entity);
                if (ev.data.entity.__identifier__ === 'minecraft:player') {
                    this.assert(actor !== null, 'Actor.fromEntity of player is null');
                }

                if (actor !== null) {
                    actor.getName();
                    this.equals(actor.getDimensionId(), DimensionId.Overworld, 'getDimensionId() is not overworld');

                    const actualId = actor.getUniqueIdLow() + ':' + actor.getUniqueIdHigh();
                    const expectedId = uniqueId["64bit_low"] + ':' + uniqueId["64bit_high"];
                    this.equals(actualId, expectedId,
                        `Actor uniqueId does not match (actual=${actualId}, expected=${expectedId})`);

                    if (ev.data.entity.__identifier__ === 'minecraft:player') {
                        const name = system.getComponent(ev.data.entity, 'minecraft:nameable')!.data.name;
                        this.equals(name, connectedId, 'id does not match');
                        this.equals(actor.getTypeId(), ActorType.Player, 'player type does not match');
                        this.assert(actor.isPlayer(), 'player is not the player');
                        this.equals(actor.getNetworkIdentifier(), connectedNi, 'the network identifier does not match');
                    } else {
                        this.assert(!actor.isPlayer(), `an entity that is not a player is a player (identifier:${ev.data.entity.__identifier__})`);
                    }
                }
            } catch (err) {
                this.processError(err);
            }
        });
    },

    chat() {
        events.packetBefore(MinecraftPacketIds.Text).on((packet, ni) => {
            if (packet.message == "TEST YEY!") {
                const MAX_CHAT = 5;
                chatCancelCounter++;
                this.log(`test (${chatCancelCounter}/${MAX_CHAT})`);
                this.equals(connectedNi, ni, 'the network identifier does not match');
                if (chatCancelCounter === MAX_CHAT) {
                    this.log('> tested and stopping...');
                    setTimeout(() => bedrockServer.stop(), 1000);
                }
                return CANCEL;
            }
        });
    },

});

let connectedNi: NetworkIdentifier;
let connectedId: string;

events.packetRaw(MinecraftPacketIds.Login).on((ptr, size, ni) => {
    connectedNi = ni;
});
events.packetAfter(MinecraftPacketIds.Login).on(ptr => {
    connectedId = ptr.connreq.cert.getId();
});
