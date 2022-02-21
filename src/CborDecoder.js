/*
 * Copyright 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not
 * use this file except in compliance with the License. A copy of the License
 * is located at
 *
 *    http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */
'use strict';

const BigNumber = require('bignumber.js');
const BigDecimal = require('./BigDecimal');
const CborTypes = require('./CborTypes');
const DaxClientError = require('./DaxClientError');
const DaxErrorCode = require('./DaxErrorCode');
const StreamBuffer = require('./ByteStreamBuffer');

const SHIFT32 = Math.pow(2, 32);

class NeedMoreData extends Error {
    constructor() {
        super('Not enough data');
    }
}

function copyBuffer(buffer, start, end) {
    start = start || 0;
    end = end || buffer.length;
    const slice = buffer.slice(start, end);
    return Buffer.from(slice);
}

class CborDecoder {
    constructor(buffer, start, end, tagHandlers) {
        if (!buffer) {
            throw new Error('buffer must be provided.');
        }

        this.buffer = buffer;
        this.start = start || 0;
        this._limit = end || buffer.length;

        this.tagHandlers = tagHandlers;

        this._byteStreamBuffer = new StreamBuffer();
    }

    peek() {
        this._ensureAvailable(1);
        return this.buffer[this.start];
    }

    skip() {
        this.decodeObject();
    }

    _consume(n) {
        this.start += n;
    }

    /**
   * Return all remaining data and advance the location to the end.
   */
    drain() {
        const remain = copyBuffer(this.buffer, this.start, this._limit);
        this.start += remain.length;
        return remain;
    }

    /**
   * Special case of drain() that returns the result as a string.
   */
    drainAsString(encoding) {
        const remain = this.buffer.toString(encoding, this.start, this._limit);
        this.start += remain.length;
        return remain;
    }

    decodeString() {
        const t = this.peek();
        if (!CborTypes.isMajorType(t, CborTypes.TYPE_UTF)) {
            throw new Error('Not string (got ' + t + ')');
        }

        this._decodeByteStringsInternal(this._byteStreamBuffer, t);
        return this._byteStreamBuffer.readAsString();
    }

    decodeBytes() {
        const t = this.peek();
        if (!CborTypes.isMajorType(t, CborTypes.TYPE_BYTES)) {
            throw new Error('Not bytes (got ' + t + ')');
        }

        this._decodeByteStringsInternal(this._byteStreamBuffer, t);
        return this._byteStreamBuffer.read();
    }

    _decodeByteStringsInternal(destStreamBuffer, cborType) {
        const length = this._decodeValue(cborType);
        if (length != -1) {
            this._ensureAvailable(length);
            destStreamBuffer.write(this.buffer.slice(this.start, this.start + length));
            this._consume(length);
        } else {
            while (!this.tryDecodeBreak()) {
                this._decodeByteStringsInternal(destStreamBuffer, this.peek());
            }
        }
    }

    decodeNumber() {
        const t = this.peek();
        switch (t) {
            case CborTypes.TYPE_FLOAT_16:
            case CborTypes.TYPE_FLOAT_32:
            case CborTypes.TYPE_FLOAT_64:
                return this.decodeFloat();
        }

        const mt = CborTypes.majorType(t);
        switch (mt) {
            case CborTypes.TYPE_POSINT:
            case CborTypes.TYPE_NEGINT:
                return this.decodeInt();

            case CborTypes.TYPE_TAG:
                const tag = this._decodeTag(t);
                switch (tag) {
                    case CborTypes.TAG_POSBIGINT:
                    case CborTypes.TAG_NEGBIGINT:
                        return this._decodeBigInt(tag);

                    case CborTypes.TAG_DECIMAL:
                        return this._decodeDecimal(tag);
                }
        }

        throw new Error('Not number');
    }

    decodeInt() {
        const t = this.peek();

        const mt = CborTypes.majorType(t);
        if (mt != CborTypes.TYPE_POSINT && mt != CborTypes.TYPE_NEGINT) {
            if (mt === CborTypes.TYPE_TAG) {
                const tag = this._decodeTag(t);
                switch (tag) {
                    case CborTypes.TAG_POSBIGINT:
                    case CborTypes.TAG_NEGBIGINT:
                        return this._decodeBigInt(tag);
                }
            }
            throw new Error('Not integer: ' + mt);
        }

        const v = this._decodeValue(t);
        return mt === CborTypes.TYPE_POSINT ? v : (v instanceof BigNumber ? v.neg().sub(1) : -v - 1);
    }

    decodeFloat() {
        const t = this.peek();

        let result; let excess;
        switch (t) {
            case CborTypes.TYPE_FLOAT_16:
                this._ensureAvailable(3);
                result = CborDecoder._parseHalf(this.buffer, this.start + 1);
                excess = 2;
                break;

            case CborTypes.TYPE_FLOAT_32:
                this._ensureAvailable(5);
                result = this.buffer.readFloatBE(this.start + 1);
                excess = 4;
                break;

            case CborTypes.TYPE_FLOAT_64:
                this._ensureAvailable(9);
                result = this.buffer.readDoubleBE(this.start + 1);
                excess = 8;
                break;

            default:
                throw new DaxClientError('Type is not float: ' + t, DaxErrorCode.Decoder);
        }

        this._consume(1 + excess);
        return result;
    }

    _decodeBigInt(tag) {
        if (tag != CborTypes.TAG_POSBIGINT && tag != CborTypes.TAG_NEGBIGINT) {
            throw new DaxClientError('Invalid tag to decode BigInt: ' + tag, DaxErrorCode.Decoder);
        }

        const t = this.peek();
        if (!CborTypes.isMajorType(t, CborTypes.TYPE_BYTES)) {
            throw new DaxClientError('Type for BigInt is not binary: ' + t, DaxErrorCode.Decoder);
        }

        const data = this.decodeBytes();
        const val = new BigNumber(data.toString('hex'), 16);

        return tag == CborTypes.TAG_POSBIGINT ? val : val.neg().sub(1);
    }

    _decodeDecimal(tag) {
        if (tag != CborTypes.TAG_DECIMAL) {
            throw new DaxClientError('Decimal value must have TAG_DECIMAL tag (got ' + tag + ')', DaxErrorCode.Decoder);
        }

        const size = this.decodeArrayLength();
        if (size != 2) {
            throw new DaxClientError('Decimal value has wrong array size (' + size + ')', DaxErrorCode.Decoder);
        }

        const scale = this.decodeInt();
        const bi = new BigNumber(this.decodeInt());

        return new BigDecimal(bi, -scale);
    }

    decodeArrayLength() {
        const t = this.peek();
        if (CborTypes.majorType(t) !== CborTypes.TYPE_ARRAY) {
            throw new Error('Not array: ' + CborTypes.majorType(t));
        }

        return this._decodeValue(t);
    }

    decodeMapLength() {
        const t = this.peek();
        if (CborTypes.majorType(t) !== CborTypes.TYPE_MAP) {
            throw new Error('Not map: ' + CborTypes.majorType(t));
        }

        return this._decodeValue(t);
    }

    decodeArray() {
        return this.buildArray(() => this.decodeObject());
    }

    decodeMap() {
        return this.buildMap(() => {
            const k = this.decodeObject();
            const v = this.decodeObject();
            return [k, v];
        });
    }

    tryDecodeBreak() {
        const val = this.peek();

        if (val === CborTypes.TYPE_BREAK) {
            this._consume(1);
            return true;
        } else {
            return false;
        }
    }

    tryDecodeNull() {
        const val = this.peek();

        if (val === CborTypes.TYPE_NULL) {
            this._consume(1);
            return true;
        } else {
            return false;
        }
    }

    decodeObject() {
        if (this.tryDecodeNull()) {
            return null;
        }

        const t = this.peek();

        // Check simple types first
        switch (t) {
            case CborTypes.TYPE_NULL:
            case CborTypes.TYPE_UNDEFINED:
                this._consume(1);
                return null;

            case CborTypes.TYPE_TRUE:
                this._consume(1);
                return true;

            case CborTypes.TYPE_FALSE:
                this._consume(1);
                return false;

            case CborTypes.TYPE_FLOAT_16:
            case CborTypes.TYPE_FLOAT_32:
            case CborTypes.TYPE_FLOAT_64:
                return this.decodeFloat();

            case CborTypes.TYPE_BREAK:
                throw new Error('Unexpected break');
        }

        // Proceed to complex types
        const mt = CborTypes.majorType(t);
        switch (mt) {
            case CborTypes.TYPE_POSINT:
            case CborTypes.TYPE_NEGINT:
                return this.decodeInt();

            case CborTypes.TYPE_BYTES:
                return this.decodeBytes();

            case CborTypes.TYPE_UTF:
                return this.decodeString();

            case CborTypes.TYPE_ARRAY:
                return this.decodeArray();

            case CborTypes.TYPE_MAP:
                return this.decodeMap();

            case CborTypes.TYPE_TAG:
                return this._decodeTaggedType(t);

            default:
                throw new Error('Unhandled type: ' + mt);
        }
    }

    /**
   * Return a decoder instance that wraps nested CBOR sent as bytes.
   *
   */
    decodeCbor() {
        const t = this.peek();
        if (!CborTypes.isMajorType(t, CborTypes.TYPE_BYTES)) {
            throw new Error('Not CBOR bytes (got ' + t + ')');
        }

        let buffer; let start; let limit;
        if (t != CborTypes.TYPE_BYTES + CborTypes.SIZE_STREAM) {
            // fixed size
            // Re-use the same buffer, but advance it in this instance
            const length = this._decodeValue(t);
            this._ensureAvailable(length);
            buffer = this.buffer;
            start = this.start;
            limit = this.start + length;
            this._consume(length);
        } else {
            // streaming
            // All of the byte segments must be gathered into one buffer
            buffer = this.decodeBytes();
            start = 0;
            limit = undefined;
        }

        // prep the subDecoder
        if (!this.subDecoder) {
            // create one if it doesn't exist
            // Ensure it is the same actual class of this instance
            const proto = Object.getPrototypeOf(this);
            this.subDecoder = new proto.constructor(buffer);
        } else {
            this.subDecoder.buffer = buffer;
        }

        this.subDecoder.start = start;

        // Set _limit so that drain() will be properly limited on the subdecoder
        // _limit is ignored (and redundant) in all other cases
        this.subDecoder._limit = limit;

        // The subDecoder can be reused since only 1 can ever be active at a time
        return this.subDecoder;
    }

    processMap(fn) {
        const length = this.decodeMapLength();
        let i = 0;
        while (i != length) {
            if (this.tryDecodeBreak()) {
                break;
            }

            fn();
            i += 1;
        }
    }

    buildMap(fn) {
        const m = {};
        this.processMap(() => {
            const r = fn();
            const k = r[0]; const v = r[1];

            if (m.hasOwnProperty(k)) {
                throw new DaxClientError('Duplicate key: ' + k, DaxErrorCode.Decoder);
            }

            m[k] = v;
        });
        return m;
    }

    processArray(fn) {
        const length = this.decodeArrayLength();
        let i = 0;
        while (i != length) {
            if (this.tryDecodeBreak()) {
                break;
            }

            fn();
            i += 1;
        }
    }

    buildArray(fn) {
        const a = [];
        this.processArray(() => a.push(fn()));
        return a;
    }

    _decodeValue(v) {
        const size = CborTypes.minorType(v);

        let result; let excess;
        if (size < CborTypes.SIZE_8) {
            result = size;
            excess = 0;
        } else {
            switch (size) {
                case CborTypes.SIZE_8:
                    this._ensureAvailable(2);
                    result = this.buffer[this.start + 1];
                    excess = 1;
                    break;

                case CborTypes.SIZE_16:
                    this._ensureAvailable(3);
                    result = this.buffer.readUInt16BE(this.start + 1);
                    excess = 2;
                    break;

                case CborTypes.SIZE_32:
                    this._ensureAvailable(5);
                    result = this.buffer.readUInt32BE(this.start + 1);
                    excess = 4;
                    break;

                case CborTypes.SIZE_64:
                    this._ensureAvailable(9);
                    // Use a BigNumber for conversion since the full 64-bit range is not safe in JS
                    const f = new BigNumber(this.buffer.readUInt32BE(this.start + 1));
                    const g = this.buffer.readUInt32BE(this.start + 5);
                    result = f.times(SHIFT32).plus(g);
                    if (result >= Number.MIN_SAFE_INTEGER && result <= Number.MAX_SAFE_INTEGER) {
                        // If it's in the safe range, convert back to a Number
                        result = result.toNumber();
                    } else {
                        // TODO Returning a BigNumber will probably cause problems, as anything
                        // calling _decodeValue needs to handle a BigNumber
                        // or, always return BigNumber, which seems wasteful as it will be a very rare case
                    }
                    excess = 8;
                    break;

                case CborTypes.SIZE_STREAM:
                    result = -1;
                    excess = 0;
                    break;

                default:
                    throw new Error('Invalid size');
            }
        }

        this._consume(1 + excess);
        return result;
    }

    _decodeTag(t) {
        if (!CborTypes.isMajorType(t, CborTypes.TYPE_TAG)) {
            throw new Error('Not a tag');
        }

        return this._decodeValue(t);
    }

    _decodeTaggedType(t) {
        const tag = this._decodeTag(t);
        switch (tag) {
            case CborTypes.TAG_POSBIGINT:
            case CborTypes.TAG_NEGBIGINT:
                return this._decodeBigInt(tag);

            case CborTypes.TAG_DECIMAL:
                return this._decodeDecimal(tag);

            default:
                if (this.tagHandlers) {
                    const handler = this.tagHandlers[tag];
                    if (handler) {
                        return handler(tag);
                    }
                }

                return this.decodeObject();
        }
    }

    _ensureAvailable(n) {
        // console.info({ n, limit: this._limit, start: this.start, buffer: this.buffer[this.start] });
        if (this._limit - this.start < n) {
            throw new NeedMoreData();
        }
    }

    static _parseHalf(buf, offset) {
        offset = offset || 0;
        const sign = buf[offset] & 0x80 ? -1 : 1;
        const exp = (buf[offset] & 0x7C) >> 2;
        const mant = ((buf[offset] & 0x03) << 8) | buf[offset + 1];
        if (!exp) {
            return sign * 5.9604644775390625e-8 * mant;
        } else if (exp === 0x1f) {
            return sign * (mant ? 0 / 0 : 2e308);
        } else {
            return sign * Math.pow(2, exp - 25) * (1024 + mant);
        }
    }
}

CborDecoder.NeedMoreData = NeedMoreData;

module.exports = CborDecoder;
