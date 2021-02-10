import { asm, FloatRegister, OperationSize, Register, Value64, X64Assembler } from "./assembler";
import { Bufferable, RawTypeId } from "./common";
import { cgate, NativePointer, StaticPointer, VoidPointer } from "./core";
import asmcode = require('./asm/asmcode');

export type ParamType = RawTypeId | { new(): VoidPointer; };

const functionTablePtr = asmcode.data;

const PARAMNUM_RETURN = -1;
const PARAMNUM_THIS = 0;

const PARAM_OFFSET = 3;
const RawTypeId_StructureReturn = 12;
const RawTypeId_WrapperToNp = 13;
const RawTypeId_WrapperToJs = 14;
const RawTypeId_Pointer = 15;

enum fn {
    runtimeErrorFire = -0x70,
    getout = -0x68,
    wrapper_np2js_nullable = -0x60,
    wrapper_np2js = -0x58,
    wrapper_js2np = -0x50,
    stack_free_all = -0x48,
    stack_ansi = -0x40,
    stack_utf8 = -0x38,
    js2np_utf16 = -0x30,
    pointer_js2np = -0x28,
    bin64 = -0x20,
    JsNumberToInt = -0x18,
    JsBoolToBoolean = -0x10,
    JsBooleanToBool = -0x08,
    getout_invalid_parameter = 0x0,
    JsIntToNumber = 0x08,
    JsNumberToDouble = 0x10,
    buffer_to_pointer = 0x18,
    JsDoubleToNumber = 0x20,
    JsPointerToString = 0x28,
    np2js_ansi = 0x30,
    np2js_utf8 = 0x38,
    np2js_utf16 = 0x40,
    np2js_pointer = 0x48,
    np2js_pointer_nullable = 0x50,
    getout_invalid_parameter_count = 0x58,
    JsCallFunction = 0x60,
    pointer_js_new = 0x68,
    JsSetException = 0x70,
    returnPoint = 0x78, // if first bit is on, it's the native wrapper.need to go runtime error
}

function getNameFromRawType(type: RawTypeId): string {
    return RawTypeId[type] || 'RawTypeId.[invalid]';
}

function throwTypeError(paramNum: number, name: string, value: string, detail: string): never {
    let out = '';
    if (paramNum === PARAMNUM_RETURN) out = 'Invalid return ';
    else if (paramNum === PARAMNUM_THIS) out = 'Invalid this ';
    else out = 'Invalid parameter ';
    out += `${name}(${value})`;
    if (paramNum > 0) out += ` at ${paramNum}`;
    out += `, ${detail}`;
    throw Error(out);
}

function invalidParamType(typeId: RawTypeId, paramNum: number): never {
    throwTypeError(paramNum, 'type', getNameFromRawType(typeId), 'Out of RawTypeId value');
}

function checkTypeIsFunction(value: unknown, paramNum: number): void {
    const type = typeof value;
    if (type !== 'function') {
        throwTypeError(paramNum, 'type', type, 'function required');
    }
}

function isBaseOf<BASE>(t: unknown, base: { new(...args: any[]): BASE }): t is { new(...args: any[]): BASE } {
    if (typeof t !== 'function') return false;
    if (t === base) return true;
    return t.prototype instanceof base;
}

function pointerClassOrThrow(paramNum: number, type: any): void {
    if (isBaseOf(type, VoidPointer)) {
        const name = type.name.toString();
        throwTypeError(paramNum, 'class', name, '*Pointer class required');
    }
}

function getRawTypeId(paramNum: number, typeValue: any): RawTypeId {
    const jstype = typeof typeValue;
    switch (jstype) {
    case 'function':
        if (typeof typeValue[makefunc.js2np] === 'function') {
            return RawTypeId_WrapperToNp;
        } else if (typeof typeValue[makefunc.np2js] === 'function') {
            return RawTypeId_WrapperToJs;
        } else {
            pointerClassOrThrow(paramNum, typeValue);
            return RawTypeId_Pointer;
        }
    case 'number':
        return typeValue as number;
    case 'object':
        if (typeof typeValue[makefunc.js2np] === 'function') {
            return RawTypeId_WrapperToNp;
        } else if (typeof typeValue[makefunc.np2js] === 'function') {
            return RawTypeId_WrapperToJs;
        }
    // fall through
    default:
        throwTypeError(paramNum, 'type', jstype, 'RawTypeId or *Pointer class required');
    }
}

const regMap: Register[] = [Register.rcx, Register.rdx, Register.r8, Register.r9];
const fregMap: FloatRegister[] = [FloatRegister.xmm0, FloatRegister.xmm1, FloatRegister.xmm2, FloatRegister.xmm3];

class ParamInfo {
    indexOnCpp: number;
    numberOnMaking: number;
    numberOnUsing: number;
    type: ParamType & {[makefunc.np2js]?():void};
    typeId: RawTypeId;
    nullable: boolean;
}

class ParamInfoMaker {
    public readonly structureReturn: boolean;
    public readonly nullableThis: boolean;
    public readonly nullableReturn: boolean;
    public readonly useThis: boolean;
    public readonly nullableParams: boolean;
    public readonly thisType: { new(): VoidPointer; };

    public readonly typeIds: RawTypeId[];
    public readonly countOnCalling: number;
    public readonly countOnCpp: number;

    constructor(
        public readonly returnType:ParamType, 
        opts:MakeFuncOptions<any>|null|undefined, 
        public readonly params:ParamType[]) {
        if (opts != null) {
            this.structureReturn = !!opts.structureReturn;
            this.thisType = opts.this;
            this.useThis = !!this.thisType;
            this.nullableReturn = !!opts.nullableReturn;
            this.nullableThis = !!opts.nullableThis;
            this.nullableParams = !!opts.nullableParams;
            if (this.useThis) {
                if (!isBaseOf(this.thisType, VoidPointer)) {
                    throw Error('Non pointer at this');
                }
            }
            if (this.nullableThis) {
                if (!this.useThis) throw Error('Invalid options.nullableThis without this type');
            }
            if (this.nullableReturn) {
                if (!isBaseOf(returnType, VoidPointer)) throw Error('Invalid options.nullableReturn with non pointer type');
            }
            if (this.nullableReturn && this.structureReturn) {
                throw Error('Invalid options.nullableReturn with structureReturn');
            }
        } else {
            this.structureReturn = false;
            this.useThis = false;
            this.nullableReturn = false;
            this.nullableThis = false;
            this.nullableParams = false;
        }
        this.countOnCalling = params.length;
        this.countOnCpp = this.countOnCalling + (+this.useThis) + (+this.structureReturn);

        if (this.useThis) this.typeIds.push(getRawTypeId(2, this.thisType));
        if (this.structureReturn) this.typeIds.push(RawTypeId_StructureReturn);
        for (let i = 0; i < params.length; i++) {
            const type: RawTypeId = getRawTypeId(i + PARAM_OFFSET + 1, params[i]);
            this.typeIds.push(type);
        }
    }

    getInfo(indexOnCpp: number): ParamInfo {
        const info = new ParamInfo;
        info.indexOnCpp = indexOnCpp;
        info.nullable = false;

        if (indexOnCpp === -1) {
            info.type = this.returnType;
            info.numberOnMaking = 2;
            info.typeId = getRawTypeId(2, info.type);
            info.numberOnUsing = PARAMNUM_RETURN;
            info.nullable = this.nullableReturn;
            return info;
        } else if (this.useThis && indexOnCpp === 0) {
            info.type = this.thisType;
            info.numberOnMaking = 3;
            info.typeId = this.typeIds[0];
            info.numberOnUsing = PARAMNUM_THIS;
            info.nullable = this.nullableThis;
            return info;
        }
        if (this.structureReturn && indexOnCpp === +this.useThis) {
            info.type = this.returnType;
            info.numberOnMaking = 2;
            info.typeId = RawTypeId_StructureReturn;
            info.numberOnUsing = PARAMNUM_RETURN;
            info.nullable = false;
            return info;
        }
        const indexOnUsing = indexOnCpp - +this.structureReturn - +this.useThis;
        const indexOnMaking = PARAM_OFFSET + indexOnUsing;
        info.type = this.params[indexOnUsing];
        info.numberOnMaking = indexOnMaking + 1;
        info.numberOnUsing = indexOnUsing + 1;
        info.typeId = this.typeIds[indexOnCpp];
        info.nullable = this.nullableParams;
        return info;
    }
}

class TargetInfo {
    reg: Register;
    freg: FloatRegister;
    offset: number;
    memory: boolean;

    equals(other: TargetInfo): boolean {
        if (this.memory) {
            return other.memory && this.reg === other.reg && this.offset === other.offset;
        }
        return !other.memory && this.reg === other.reg;
    }

    static register(reg: Register, freg: FloatRegister): TargetInfo {
        const ti = new TargetInfo;
        ti.reg = reg;
        ti.freg = freg;
        ti.memory = false;
        return ti;
    }
    static memory(reg: Register, offset: number): TargetInfo {
        const ti = new TargetInfo;
        ti.reg = reg;
        ti.offset = offset;
        ti.memory = true;
        return ti;
    }

    tempPtr(...sources:TargetInfo[]): TargetInfo {
        if (this.memory) return this;
        let offsets = 0;
        for (const src of sources) {
            if (src.memory && src.reg === Register.rbp) {
                console.assert(src.offset%8 === 0);
                offsets |= 1 << (src.offset>>3);
                continue;
            }
        }
        let offset = 0;
        while ((offsets & 1) !== 0) {
            offsets >>>= 1;
            offset += 8;
        }
        return TargetInfo.memory(Register.rbp, offset);
    }
}

const TARGET_RETURN = TargetInfo.register(Register.rax, FloatRegister.xmm0);
const TARGET_1 = TargetInfo.register(Register.rcx, FloatRegister.xmm0);

class Maker extends X64Assembler {
    public offsetForStructureReturn: number;
    public useStackAllocator = false;

    constructor(
        public readonly pi: ParamInfoMaker,
        public readonly stackSize: number,
        private readonly useGetOut: boolean) {
        super();


        this.push_r(Register.rdi);
        this.push_r(Register.rsi);
        this.push_r(Register.rbp);
        this.mov_r_c(Register.rdi, functionTablePtr);
        if (useGetOut) {
            this.mov_r_rp(Register.rax, Register.rdi, fn.returnPoint);
        }
        this.push_r(Register.rax);

        if (useGetOut) {
            this.lea_r_rp(Register.rax, Register.rsp, 1);
            this.mov_rp_r(Register.rdi, fn.returnPoint, Register.rax);
        }
    }

    end(): void {
        this.add_r_c(Register.rsp, this.stackSize);
        this.pop_r(Register.rcx);
        this.pop_r(Register.rbp);
        this.mov_rp_r(Register.rdi, fn.returnPoint, Register.rcx);
        this.pop_r(Register.rsi);
        this.pop_r(Register.rdi);
        this.ret();
    }

    _mov_t_c(target: TargetInfo, value: Value64): void {
        if (target.memory) {
            const temp = target.reg !== Register.r10 ? Register.r10 : Register.r11;
            this.mov_r_c(temp, value);
            this.mov_rp_c(target.reg, target.offset, temp);
        } else {
            this.mov_r_c(target.reg, value);
        }
    }

    _mov_t_t(target: TargetInfo, source: TargetInfo, type: RawTypeId, reverse: boolean): void {
        if (target.memory) {
            const temp = target.reg !== Register.r10 ? Register.r10 : Register.r11;
            const ftemp = target.freg !== FloatRegister.xmm5 ? FloatRegister.xmm5 : FloatRegister.xmm6;

            if (source.memory) {
                if (type === RawTypeId.FloatAsInt64) {
                    if (reverse) {
                        this.cvtsi2sd_r_rp(ftemp, source.reg, source.offset);
                        this.movsd_rp_r(target.reg, target.offset, ftemp);
                    } else {
                        this.cvttsd2si_r_rp(temp, source.reg, source.offset);
                        this.mov_rp_r(target.reg, target.offset, temp);
                    }
                } else if (type === RawTypeId.Boolean) {
                    if (target === source) {
                        // same
                    } else {
                        this.movzx_r_rp(temp, source.reg, source.offset);
                        this.mov_rp_r(target.reg, target.offset, temp, OperationSize.byte);
                    }
                } else if (type === RawTypeId.Int32) {
                    if (target === source) {
                        // same
                    } else {
                        this.movsxd_r_rp(temp, source.reg, source.offset);
                        this.mov_rp_r(target.reg, target.offset, temp);
                    }
                } else {
                    if (target === source) {
                        // same
                    } else {
                        this.mov_r_rp(temp, source.reg, source.offset);
                        this.mov_rp_r(target.reg, target.offset, temp);
                    }
                }
            } else {
                if (type === RawTypeId.FloatAsInt64) {
                    if (reverse) { // int64_t.float64_t
                        this.cvtsi2sd_r_r(FloatRegister.xmm0, source.reg);
                        this.movsd_rp_r(target.reg, target.offset, FloatRegister.xmm0);
                    } else { // float64_t.int64_t
                        this.cvttsd2si_r_r(temp, source.freg);
                        this.mov_rp_r(target.reg, target.offset, temp);
                    }
                } else if (type === RawTypeId.Float64) {
                    this.movsd_rp_r(target.reg, target.offset, source.freg);
                } else if (type === RawTypeId.Float32) {
                    if (reverse) { // float32_t.float64_t
                        this.cvtss2sd_r_r(FloatRegister.xmm0, source.freg);
                        this.movsd_rp_r(target.reg, target.offset, FloatRegister.xmm0);
                    } else { // float64_t.float32_t
                        this.cvtsd2ss_r_r(FloatRegister.xmm0, source.freg);
                        this.movss_rp_r(target.reg, target.offset, FloatRegister.xmm0);
                    }
                } else if (type === RawTypeId.Boolean) {
                    this.mov_rp_r(target.reg, target.offset, source.reg, OperationSize.byte);
                } else {
                    this.mov_rp_r(target.reg, target.offset, source.reg);
                }
            }
        } else {
            if (source.memory) {
                if (type === RawTypeId.FloatAsInt64) {
                    if (reverse) {
                        this.cvtsi2sd_r_rp(target.freg, source.reg, source.offset);
                    } else {
                        this.cvttsd2si_r_rp(target.reg, source.reg, source.offset);
                    }
                } else if (type === RawTypeId.Float64) {
                    this.movsd_r_rp(target.freg, source.reg, source.offset);
                } else if (type === RawTypeId.Float32) {
                    if (reverse) { // float32_t.float64_t
                        this.cvtss2sd_r_rp(target.freg, source.reg, source.offset);
                    } else { // float64_t.float32_t
                        this.cvtsd2ss_r_rp(target.freg, source.reg, source.offset);
                    }
                } else if (type === RawTypeId.Boolean) {
                    this.movzx_r_rp(target.reg, source.reg, source.offset);
                } else if (type === RawTypeId.Int32) {
                    this.movsxd_r_rp(target.reg, source.reg, source.offset);
                } else {
                    this.mov_r_rp(target.reg, source.reg, source.offset);
                }
            } else {
                if (type === RawTypeId.FloatAsInt64) {
                    if (reverse) {
                        this.cvtsi2sd_r_r(target.freg, source.reg);
                    } else {
                        this.cvttsd2si_r_r(target.reg, source.freg);
                    }
                } else {
                    if (target !== source) {
                        if (type === RawTypeId.Float64) {
                            this.movsd_r_r(target.freg, source.freg);
                        } else if (type === RawTypeId.Float32) {
                            if (reverse) { // float32_t.float64_t
                                this.cvtss2sd_r_r(target.freg, source.freg);
                            } else { // float64_t.float32_t
                                this.cvtsd2ss_r_r(target.freg, source.freg);
                            }
                        } else {
                            this.mov_r_r(target.reg, source.reg);
                        }
                    }
                }
            }
        }
    }

    nativeToJs(info:ParamInfo, target:TargetInfo, source:TargetInfo):void {
        switch (info.typeId) {
        case RawTypeId_StructureReturn: {
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, true);
            break;
        }
        case RawTypeId_WrapperToNp:
        case RawTypeId_Pointer: {
            pointerClassOrThrow(info.numberOnMaking, info.type);
            cgate.JsAddRef(info.type);
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, true);
            this.mov_r_c(Register.rdx, cgate.asJsValueRef(info.type));
            if (info.nullable) {
                this.call_rp(Register.rdi, fn.np2js_pointer_nullable);
            } else {
                this.call_rp(Register.rdi, fn.np2js_pointer);
            }
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, true);
            break;
        }
        case RawTypeId_WrapperToJs: {
            const np2js_fn = info.type[makefunc.np2js];
            if (np2js_fn) cgate.JsAddRef(np2js_fn);

            this._mov_t_t(TARGET_1, source, RawTypeId.Void, true);
            this.mov_r_c(Register.rdx, cgate.asJsValueRef(info.type));
            if (isBaseOf(info.type, VoidPointer)) {
                cgate.JsAddRef(info.type);
                this.mov_r_c(Register.r8, cgate.asJsValueRef(info.type));
            } else {
                this.mov_r_c(Register.r8, cgate.asJsValueRef(NativePointer));
            }
            if (info.nullable) {
                this.call_rp(Register.rdi, fn.wrapper_np2js_nullable);
            } else {
                this.call_rp(Register.rdi, fn.wrapper_np2js);
            }
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, true);
            break;
        }
        case RawTypeId.Boolean: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsBoolToBoolean);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, RawTypeId.Void, true);
            break;
        }
        case RawTypeId.Int32: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsIntToNumber);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, RawTypeId.Void, true);
            break;
        }
        case RawTypeId.FloatAsInt64: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsDoubleToNumber);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, RawTypeId.Void, true);
            break;
        }
        case RawTypeId.Float64: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsDoubleToNumber);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, RawTypeId.Void, true);
            break;
        }
        case RawTypeId.Float32: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsDoubleToNumber);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, RawTypeId.Void, true);
            break;
        }
        case RawTypeId.StringAnsi:
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.np2js_ansi);
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, true);
            break;
        case RawTypeId.StringUtf8:
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.np2js_utf8);
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, true);
            break;
        case RawTypeId.StringUtf16:
            this._mov_t_t(TARGET_1, source, info.typeId, true);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.np2js_utf16);
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, true);
            break;
        case RawTypeId.Bin64: {
            const temp = target.tempPtr(source, TargetInfo.memory(Register.rbp, 8));
            if (source.memory) {
                this.lea_r_rp(Register.rcx, source.reg, source.offset);
            } else {
                this.lea_r_rp(Register.rcx, Register.rbp, 8);
                this.mov_rp_r(Register.rcx, 0, source.reg);
            }
            this.mov_r_c(Register.rdx, 4);
            this.lea_r_rp(Register.r8, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsPointerToString);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, RawTypeId.Void, true);
            break;
        }
        case RawTypeId.JsValueRef:
            this._mov_t_t(target, source, info.typeId, true);
            break;
        case RawTypeId.Void:
            this._mov_t_c(target, cgate.asJsValueRef(undefined));
            break;
        default:
            invalidParamType(info.typeId, info.numberOnUsing);
        }
    }

    jsToNative(info:ParamInfo, target:TargetInfo, source:TargetInfo):void {
        switch (info.typeId) {
        case RawTypeId_StructureReturn: {
            this.lea_r_rp(Register.rdx, Register.rbp, this.offsetForStructureReturn);

            cgate.JsAddRef(info.type);
            this.mov_r_c(Register.rcx, cgate.asJsValueRef(info.type));
            this.call_rp(Register.rdi, fn.pointer_js_new);
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, true);
            break;
        }
        case RawTypeId_WrapperToNp: {
            cgate.JsAddRef(info.type);

            this._mov_t_t(TARGET_1, source, RawTypeId.Void, true);
            this.mov_r_c(Register.rdx, cgate.asJsValueRef(info.type));
            this.call_rp(Register.rdi, fn.wrapper_js2np);
            if (info.numberOnUsing === PARAMNUM_THIS) {
                if (!this.pi.nullableThis) {
                    this.test_r_r(Register.rax, Register.rax);
                    this.jnz(9);
                    this.mov_r_c(Register.rcx, info.numberOnUsing);
                    this.call_rp(Register.rdi, fn.getout_invalid_parameter);
                }
            }
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, false);
            break;
        }
        case RawTypeId_WrapperToJs:
        case RawTypeId_Pointer: {
            pointerClassOrThrow(info.numberOnMaking, info.type);
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.call_rp(Register.rdi, fn.pointer_js2np);
            if (info.numberOnUsing === PARAMNUM_THIS) {
                if (!this.pi.nullableThis) {
                    this.test_r_r(Register.rax, Register.rax);
                    this.jnz(9);
                    this.mov_r_c(Register.rcx, info.numberOnUsing);
                    this.call_rp(Register.rdi, fn.getout_invalid_parameter);
                }
            }
            this._mov_t_t(target, TARGET_RETURN, RawTypeId.Void, false);
            break;
        }
        case RawTypeId.Boolean: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsBooleanToBool);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, info.typeId, false);
            break;
        }
        case RawTypeId.Int32: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsNumberToInt);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, info.typeId, false);
            break;
        }
        case RawTypeId.FloatAsInt64: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsNumberToDouble);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, info.typeId, false);
            break;
        }
        case RawTypeId.Float64: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsNumberToDouble);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, info.typeId, false);
            break;
        }
        case RawTypeId.Float32: {
            const temp = target.tempPtr();
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.lea_r_rp(Register.rdx, temp.reg, temp.offset);
            this.call_rp(Register.rdi, fn.JsNumberToDouble);
            this.test_r_r(Register.rax, Register.rax);
            this.jz(9);
            this.mov_r_c(Register.rcx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.getout_invalid_parameter);
            this._mov_t_t(target, temp, info.typeId, false);
            break;
        }
        case RawTypeId.StringAnsi:
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.stack_ansi);
            this._mov_t_t(target, TARGET_RETURN, info.typeId, false);
            this.useStackAllocator = true;
            break;
        case RawTypeId.StringUtf8:
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.stack_utf8);
            this._mov_t_t(target, TARGET_RETURN, info.typeId, false);
            this.useStackAllocator = true;
            break;
        case RawTypeId.StringUtf16:
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.js2np_utf16);
            this._mov_t_t(target, TARGET_RETURN, info.typeId, false);
            break;
        case RawTypeId.Buffer:
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.buffer_to_pointer);
            this._mov_t_t(target, TARGET_RETURN, info.typeId, false);
            break;
        case RawTypeId.Bin64:
            this._mov_t_t(TARGET_1, source, RawTypeId.Void, false);
            this.mov_r_c(Register.rdx, info.numberOnUsing);
            this.call_rp(Register.rdi, fn.bin64);
            this._mov_t_t(target, TARGET_RETURN, info.typeId, false);
            break;
        case RawTypeId.JsValueRef:
            this._mov_t_t(target, source, info.typeId, false);
            break;
        case RawTypeId.Void:
            if (target === TARGET_RETURN) break;
            // fall through
        default:
            invalidParamType(info.typeId, info.numberOnMaking);
        }
    }
}

interface TypeMap_np2js {
    [RawTypeId.Int32]: number;
    [RawTypeId.FloatAsInt64]: number;
    [RawTypeId.Float32]: number;
    [RawTypeId.Float64]: number;
    [RawTypeId.StringAnsi]: string;
    [RawTypeId.StringUtf8]: string;
    [RawTypeId.StringUtf16]: string;
    [RawTypeId.Buffer]: void;
    [RawTypeId.Bin64]: string;
    [RawTypeId.Boolean]: boolean;
    [RawTypeId.JsValueRef]: any;
    [RawTypeId.Void]: void;
}

interface TypeMap_js2np {
    [RawTypeId.Int32]: number;
    [RawTypeId.FloatAsInt64]: number;
    [RawTypeId.Float32]: number;
    [RawTypeId.Float64]: number;
    [RawTypeId.StringAnsi]: string|null;
    [RawTypeId.StringUtf8]: string|null;
    [RawTypeId.StringUtf16]: string|null;
    [RawTypeId.Buffer]: VoidPointer|Bufferable|null;
    [RawTypeId.Bin64]: string;
    [RawTypeId.Boolean]: boolean;
    [RawTypeId.JsValueRef]: any;
    [RawTypeId.Void]: void;
}

type TypeFrom_js2np<T extends ParamType|{new():VoidPointer|void}> = 
    T extends RawTypeId ? TypeMap_js2np[T] : 
    T extends { new(...args: any[]): infer V } ? (V|null) : 
    never;
type TypeFrom_np2js<T extends ParamType> = 
    T extends RawTypeId ? TypeMap_np2js[T] : 
    T extends { new(): infer V } ? V : 
    never;

export type TypesFromParamIds_js2np<T extends ParamType[]> = {
    [key in keyof T]: T[key] extends null ? void : T[key] extends ParamType ? TypeFrom_js2np<T[key]> : T[key];
};
export type TypesFromParamIds_np2js<T extends ParamType[]> = {
    [key in keyof T]: T[key] extends null ? void : T[key] extends ParamType ? TypeFrom_np2js<T[key]> : T[key];
};


export interface MakeFuncOptions<THIS extends { new(): VoidPointer|void; }>
{
    /**
     * *Pointer, 'this' parameter passes as first parameter.
     */
    this?:THIS;
    /**
     * it allocates at the first parameter with the returning class and returns it.
     * if this is defined, it allocates at the second parameter.
     */
    structureReturn?:boolean;
    nullableReturn?:boolean;
    nullableThis?:boolean;
    nullableParams?:boolean;
}
type GetThisFromOpts<OPTS extends MakeFuncOptions<any>|null> = 
    OPTS extends MakeFuncOptions<infer THIS> ? 
    THIS extends { new(): VoidPointer; } ? InstanceType<THIS> : void : void;


export type FunctionFromTypes_np<
    OPTS extends MakeFuncOptions<any>|null,
    PARAMS extends ParamType[],
    RETURN extends ParamType> =
    (this:GetThisFromOpts<OPTS>, ...args: TypesFromParamIds_np2js<PARAMS>) => TypeFrom_js2np<RETURN>;
    
export type FunctionFromTypes_js<
    PTR extends VoidPointer|[number, number?],
    OPTS extends MakeFuncOptions<any>|null,
    PARAMS extends ParamType[],
    RETURN extends ParamType> =
    ((this:GetThisFromOpts<OPTS>, ...args: TypesFromParamIds_js2np<PARAMS>) => TypeFrom_np2js<RETURN>)& {pointer:PTR};

export namespace makefunc {
        
    /**
     * make the JS function as a native function.
     * 
     * wrapper codes are not deleted permanently.
     * do not use it dynamically.
     */
    export function np<RETURN extends ParamType, OPTS extends MakeFuncOptions<any>|null, PARAMS extends ParamType[]>(
        jsfunction: FunctionFromTypes_np<OPTS, PARAMS, RETURN>,
        returnType: RETURN, opts?: OPTS, ...params: PARAMS): VoidPointer {
        const pimaker = new ParamInfoMaker(returnType, opts, params); // check param count also
    
        cgate.JsAddRef(jsfunction);
        checkTypeIsFunction(jsfunction, 1);
    
        const paramsSize = pimaker.countOnCalling * 8 + 8; // params + this
        let stackSize = paramsSize;
        stackSize += 0x10; // temp space
        stackSize += 0x20; // calling space (use stack through ending)
        if (stackSize < 0x20) stackSize = 0x20; // minimal
    
        // alignment
        const alignmentOffset = 8;
        stackSize -= alignmentOffset;
        stackSize = ((stackSize + 0xf) & ~0xf);
        stackSize += alignmentOffset;
    
        const func = new Maker(pimaker, stackSize, false);
        // 0x20~0x28 - return address
        // 0x00~0x20 - pushed data
        func.lea_r_rp(Register.rbp, Register.rsp, 0x28);
    
        const activeRegisters = Math.min(pimaker.countOnCpp, 4);
        if (activeRegisters > 1) {
            for (let i = 1; i < activeRegisters; i++) {
                const offset = i * 8;
                const typeId = pimaker.typeIds[i];
                if (typeId === RawTypeId.Float64) {
                    const freg = fregMap[i];
                    func.movsd_rp_r(Register.rbp, offset, freg);
                } else if (typeId === RawTypeId.Float32) {
                    const freg = fregMap[i];
                    func.movss_rp_r(Register.rbp, offset, freg);
                } else {
                    const reg = regMap[i];
                    func.mov_rp_r(Register.rbp, offset, reg);
                }
            }
        }
    
        func.lea_r_rp(Register.rsi, Register.rsp, -func.stackSize + 0x20); // without calling stack
        func.sub_r_c(Register.rsp, func.stackSize);
    
        let offset = 0;
        if (!pimaker.useThis) {
            func._mov_t_c(TargetInfo.memory(Register.rsi, 0), cgate.asJsValueRef(global));
        }
    
        for (let i = 0; i < pimaker.countOnCpp; i++) {
            const info = pimaker.getInfo(i);
            if (i === 0) {
                func.nativeToJs(info, TargetInfo.memory(Register.rsi, info.numberOnUsing * 8), TARGET_1);
            } else {
                func.nativeToJs(info, 
                    TargetInfo.memory(Register.rsi, info.numberOnUsing * 8), 
                    TargetInfo.memory(Register.rbp, offset));
            }
            offset += 8;
        }
    
        func.mov_r_c(Register.rcx, cgate.asJsValueRef(jsfunction));
        func.lea_r_rp(Register.rdx, Register.rsp, 0x20);
        func.mov_r_c(Register.r8, pimaker.countOnCalling + 1);
        func.mov_r_r(Register.r9, Register.rbp);
        func.call_rp(Register.rdi, fn.JsCallFunction);
    
        func.test_r_r(Register.rax, Register.rax);
        func.jz(6);
        func.mov_r_r(Register.rcx, Register.rax);
        func.call_rp(Register.rdi, fn.getout);
    
        func.jsToNative(pimaker.getInfo(-1), TARGET_RETURN, TargetInfo.memory(Register.rbp, 0));
    
        func.end();
        return func.alloc();
    }
    /**
     * make the native function as a JS function.
     * 
     * wrapper codes are not deleted permanently.
     * do not use it dynamically.
     * 
     * @param returnType RawTypeId or *Pointer
     * @param params RawTypeId or *Pointer
     */
    export function js<PTR extends VoidPointer|[number, number?], OPTS extends MakeFuncOptions<any>|null, RETURN extends ParamType, PARAMS extends ParamType[]>(
        functionPointer: PTR,
        returnType:RETURN,
        opts?: OPTS, 
        ...params: PARAMS):
        FunctionFromTypes_js<PTR, OPTS, PARAMS, RETURN> {
        const pimaker = new ParamInfoMaker(returnType, opts, params); // check param count also
    
        let vfoff:number|undefined;
        if (!(functionPointer instanceof VoidPointer)) {
            vfoff = (functionPointer as any)[0];
            if (typeof vfoff !== 'number') {
                throwTypeError(1, 'type', typeof functionPointer, '*Pointer or [number, number] required');
            }
        }
    
        // JsValueRef( * JsNativeFunction)(JsValueRef callee, bool isConstructCall, JsValueRef *arguments, unsigned short argumentCount, void *callbackState);
    
        const paramsSize = pimaker.countOnCpp * 8;
        let stackSize = paramsSize;
        if (pimaker.structureReturn) stackSize += 0x8; // structureReturn space
        stackSize += 0x10; // temp space space
        if (stackSize < 0x20) stackSize = 0x20; // minimal
    
        // alignment
        const alignmentOffset = 8;
        stackSize -= alignmentOffset;
        stackSize = ((stackSize + 0xf) & ~0xf);
        stackSize += alignmentOffset;
    
        const func = new Maker(pimaker, stackSize, true);

        let targetfuncptr:VoidPointer|null;
        if (vfoff === undefined) {
            targetfuncptr = functionPointer as any;
        } else {
            targetfuncptr = null;
            if (pimaker.nullableThis) throw Error("Cannot use nullableThis at the virtual function");
        }
        if (pimaker.countOnCalling !== 0) {
            func.cmp_r_c(Register.r9, pimaker.countOnCalling + 1);
            func.jz(14);
            func.mov_r_c(Register.rdx, pimaker.countOnCalling); // 7 bytes
            func.lea_r_rp(Register.rcx, Register.r9, -1); // 4 bytes
            func.jmp_rp(Register.rdi, fn.getout_invalid_parameter_count); // 3 bytes
        }
        func.mov_r_r(Register.rsi, Register.r8);
        func.lea_r_rp(Register.rbp, Register.rsp, - func.stackSize + paramsSize);
    
        if (pimaker.structureReturn) {
            func.offsetForStructureReturn = func.stackSize - paramsSize - 8;
        }
    
        if (pimaker.countOnCpp > 1) {
            const stackSizeForConvert = 0x20;
            func.sub_r_c(Register.rsp, func.stackSize + stackSizeForConvert);
    
            const last = pimaker.countOnCpp - 1;
            let offset = -paramsSize;
            for (let i = 0; i < pimaker.countOnCpp; i++) {
                const info = pimaker.getInfo(i);
                func.jsToNative(info,
                    i !== last ? TargetInfo.memory(Register.rbp, offset) : i < 4 ? 
                        TargetInfo.memory(regMap[i], fregMap[i]) : 
                        TargetInfo.memory(Register.rbp, offset),
                    TargetInfo.memory(Register.rsi, info.numberOnUsing * 8));
                offset += 8;
            }
    
            if (func.useStackAllocator) {
                func.mov_r_c(Register.rax, cgate.stack_ptr);
                func.or_rp_c(Register.rax, 0, 1);
            }
    
            func.add_r_c(Register.rsp, stackSizeForConvert);
    
            // paramCountOnCpp >= 2
            if (pimaker.typeIds[0] === RawTypeId.Float64) {
                func.movsd_r_rp(FloatRegister.xmm0, Register.rsp, 0);
            } else if (pimaker.typeIds[0] === RawTypeId.Float32) {
                func.movss_r_rp(FloatRegister.xmm0, Register.rsp, 0);
            } else {
                func.mov_r_rp(Register.rcx, Register.rsp, 0);
            }
            if (pimaker.countOnCpp >= 3) {
                if (pimaker.typeIds[1] === RawTypeId.Float64) {
                    func.movsd_r_rp(FloatRegister.xmm1, Register.rsp, 8);
                } else if (pimaker.typeIds[1] === RawTypeId.Float32) {
                    func.movss_r_rp(FloatRegister.xmm1, Register.rsp, 8);
                } else {
                    func.mov_r_rp(Register.rdx, Register.rsp, 8);
                }
                if (pimaker.countOnCpp >= 4) {
                    if (pimaker.typeIds[2] === RawTypeId.Float64) {
                        func.movsd_r_rp(FloatRegister.xmm2, Register.rsp, 16);
                    } else if (pimaker.typeIds[2] === RawTypeId.Float32) {
                        func.movss_r_rp(FloatRegister.xmm2, Register.rsp, 16);
                    } else {
                        func.mov_r_rp(Register.r8, Register.rsp, 16);
                    }
                    if (pimaker.countOnCpp >= 5) {
                        if (pimaker.typeIds[3] === RawTypeId.Float64) {
                            func.movsd_r_rp(FloatRegister.xmm3, Register.rsp, 24);
                        } else if (pimaker.typeIds[3] === RawTypeId.Float32) {
                            func.movss_r_rp(FloatRegister.xmm3, Register.rsp, 24);
                        } else {
                            func.mov_r_rp(Register.r9, Register.rsp, 24);
                        }
                    }
                }
            }
        } else {
            func.sub_r_c(Register.rsp, func.stackSize);
    
            if (pimaker.countOnCpp !== 0) {
                const pi = pimaker.getInfo(0);
                func.jsToNative(pi, TARGET_1, TargetInfo.memory(Register.rsi, pi.numberOnUsing * 8));
            }
    
            if (func.useStackAllocator) {
                func.mov_r_c(Register.rax, cgate.stack_ptr);
                func.or_rp_c(Register.rax, 0, 1);
            }
        }
    
        if (targetfuncptr !== null) {
            func.call64(targetfuncptr, Register.rax);
        } else {
            const thisoff = (functionPointer as number[])[1] || 0;
            func.mov_r_rp(Register.rax, Register.rcx, thisoff);
            func.call_rp(Register.rax, vfoff!);
        }
    
        let returnTarget = TARGET_RETURN;
        if (func.useStackAllocator) {
            if (!pimaker.structureReturn) {
                const retTypeCode = getRawTypeId(PARAMNUM_RETURN, returnType);
                if (retTypeCode === RawTypeId.Float64) {
                    func.movsd_rp_r(Register.rbp, 0, FloatRegister.xmm0);
                } else if (retTypeCode === RawTypeId.Float32) {
                    func.movss_rp_r(Register.rbp, 0, FloatRegister.xmm0);
                } else {
                    func.mov_rp_r(Register.rbp, 0, Register.rax);
                }
                returnTarget = TargetInfo.memory(Register.rbp, 0);
            }
            func.mov_r_c(Register.rdx, cgate.stack_ptr);
            func.and_rp_c(Register.rdx, 0, -2);
            func.call_rp(Register.rdi, fn.stack_free_all);
        }
    
        if (pimaker.structureReturn) {
            func.mov_r_rp(Register.rax, Register.rbp, func.stackSize - paramsSize - 8);
        } else {
            func.nativeToJs(pimaker.getInfo(-1), TARGET_RETURN, returnTarget);
        }
    
        func.end();
        const nativecode = func.alloc();
        const funcout = cgate.JsCreateFunction(nativecode, null) as FunctionFromTypes_js<PTR, OPTS, PARAMS, RETURN>;
        funcout.pointer = functionPointer;
        return funcout;
    }
    export import asJsValueRef = cgate.asJsValueRef;
    export const js2np = Symbol('makefunc.js2np');
    export const np2js = Symbol('makefunc.np2js');
}

declare module "./assembler"
{
    interface X64Assembler
    {
        make<OPTS extends MakeFuncOptions<any>|null, RETURN extends ParamType, PARAMS extends ParamType[]>(
            returnType: RETURN, opts?: OPTS, ...params: PARAMS):
            FunctionFromTypes_js<StaticPointer, OPTS, PARAMS, RETURN>;
        alloc():StaticPointer;
        allocs():Record<string, StaticPointer>;
    }
    namespace asm
    {
        interface CodeBuffer
        {
            alloc():StaticPointer;
            allocs():Record<string, StaticPointer>;
        }
        function const_str(str:string, encoding?:BufferEncoding):Buffer;
    }
}
declare module "./core"
{
    interface VoidPointer
    {
        [asm.splitTwo32Bits]():[number, number];
    }
}
declare global
{
    interface Uint8Array
    {
        [asm.splitTwo32Bits]():[number, number];
    }
}

VoidPointer.prototype[asm.splitTwo32Bits] = function() {
    return [this.getAddressLow(), this.getAddressHigh()];
};
Uint8Array.prototype[asm.splitTwo32Bits] = function() {
    const ptr = new NativePointer;
    ptr.setAddressFromBuffer(this);
    return [ptr.getAddressLow(), ptr.getAddressHigh()];
};

asm.const_str = function(str:string, encoding:BufferEncoding='utf-8'):Buffer {
    const buf = Buffer.from(str+'\0', encoding);
    cgate.JsAddRef(buf);
    return buf;
};

X64Assembler.prototype.make = function<OPTS extends MakeFuncOptions<any>|null, RETURN extends ParamType, PARAMS extends ParamType[]>(
    this:X64Assembler, returnType:RETURN, opts?:OPTS, ...params:PARAMS):
	FunctionFromTypes_js<StaticPointer, OPTS, PARAMS, RETURN>{
    return makefunc.js(this.alloc(), returnType, opts,  ...params);
};

X64Assembler.prototype.alloc = function():StaticPointer {
    return this.buffer().alloc();
};

X64Assembler.prototype.allocs = function():Record<string, StaticPointer> {
    return this.buffer().allocs();
};

asm.CodeBuffer.prototype.alloc = function():StaticPointer {
    const mem = cgate.allocExecutableMemory(this.memory+this.length, this.alignment);
    mem.setBuffer(this, this.memory);
    return mem;
};

asm.CodeBuffer.prototype.allocs = function():Record<string, StaticPointer> {
    const mem = cgate.allocExecutableMemory(this.memory+this.length, this.alignment);
    mem.setBuffer(this, this.memory);
    const out:Record<string, StaticPointer> = {};
    for (const name in this.labels) {
        out[name] = mem.add(this.labels[name]);
    }
    return out;
};
