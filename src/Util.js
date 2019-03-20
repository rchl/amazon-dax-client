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
const ALPHABET = '0123456789abcdef';
const DaxClientError = require('./DaxClientError');
const DaxErrorCode = require('./DaxErrorCode');

class Util {
  static convertBase(str, baseIn, baseOut) {
    if(str[0] === '-') {
      str = str.slice(1);
    }
    let j;
    let arr = [0];
    let arrL;
    let i = 0;
    let len = str.length;

    for(; i < len;) {
      for(arrL = arr.length; arrL--; arr[arrL] *= baseIn) {

      }
      arr[j = 0] += ALPHABET.indexOf(str[i++]);

      for(; j < arr.length; j++) {
        if(arr[j] > baseOut - 1) {
          if(arr[j + 1] == null) {
            arr[j + 1] = 0;
          }
          arr[j + 1] += arr[j] / baseOut | 0;
          arr[j] %= baseOut;
        }
      }
    }

    let outstr = '';
    for(i = arr.length - 1; i >= 0; --i) {
      outstr += ALPHABET[arr[i]];
    }
    if(baseOut === 16) { // to hex then has to have certain length
      switch(true) {
        case outstr.length <= 2:
          outstr = '0'.repeat(2 - outstr.length) + outstr;
          break;
        case outstr.length <= 4:
          outstr = '0'.repeat(4 - outstr.length) + outstr;
          break;
        case outstr.length <= 8:
          outstr = '0'.repeat(8 - outstr.length) + outstr;
          break;
        case outstr.length <= 16:
          outstr = '0'.repeat(16 - outstr.length) + outstr;
          break;
        default:
          outstr = ((outstr.length % 2) ? '0' : '') + outstr;
      }
    }
    return outstr;
  }

  static parseHostPorts(hostports) {
    // Handle the case of a single string
    if(typeof hostports === 'string') {
      return [Util.parseHostPort(hostports)];
    }

    let addrs = [];
    for(let hostport of hostports) {
      addrs.push(Util.parseHostPort(hostport));
    }
    return addrs;
  }

  static parseHostPort(hostport) {
    let colon = hostport.indexOf(':');
    if(colon <= 0) {
      throw new DaxClientError('Invalid hostport:' + hostport, DaxErrorCode.IllegalArgument, false);
    }

    let host = hostport.substr(0, colon);
    let port = hostport.substr(colon + 1);
    if(isNaN(port)) {
      throw new DaxClientError('Invalid hostport:' + hostport, DaxErrorCode.IllegalArgument, false);
    }
    port = parseInt(port);

    return {host: host, port: port};
  }

  static objEqual(a, b) {
    // Create arrays of property names
    if(!a || !b) {
      return a === b;
    }

    if(typeof(a) === typeof(b)) {
      // handle primitive types using native equality
      switch(typeof(a)) {
        case 'string':
        case 'number':
        case 'boolean':
          return a === b;
      }
    }

    let aProps = Object.getOwnPropertyNames(a);
    let bProps = Object.getOwnPropertyNames(b);

    // If number of properties is different,
    // objects are not equivalent
    if(aProps.length != bProps.length) {
      return false;
    }

    for(let i = 0; i < aProps.length; i++) {
      let propName = aProps[i];

      // If values of same property are not equal,
      // objects are not equivalent
      if(typeof a[propName] === 'object') {
        if(!Util.objEqual(a[propName], b[propName])) {
          return false;
        }
      } else if(a[propName] !== b[propName]) {
        return false;
      }
    }

    // If we made it this far, objects
    // are considered equivalent
    return true;
  }

  // compare two Lists
  static arrayEquals(lista, listb) {
    if(lista.length !== listb.length) {
      return false;
    }
    let usedIndex = new Set();
    for(let i = 0; i < lista.length; ++i) {
      let equal = false;
      for(let j = 0; j < listb.length; ++j) {
        if(!usedIndex.has(j) && Util.objEqual(lista[i], listb[j])) {
          equal = true;
          usedIndex.add(j);
          break;
        }
      }
      if(!equal) {
        return false;
      }
    }
    return true;
  }

  // compare two sorted Lists
  static sortedArrayEquals(lista, listb) {
    if(lista.length !== listb.length) {
      return false;
    }

    for(let i = 0; i < lista.length; ++i) {
      if(!Util.objEqual(lista[i], listb[i])) {
        return false;
      }
    }

    return true;
  }

  static objArrayEquals(a, b) {
    // Create arrays of property names
    if(!a || !b) {
      return a === b;
    }

    if(typeof(a) === typeof(b)) {
      // handle primitive types using native equality
      switch(typeof(a)) {
        case 'string':
        case 'number':
        case 'boolean':
          return a === b;
      }
    }

    let aProps = Object.getOwnPropertyNames(a);
    let bProps = Object.getOwnPropertyNames(b);

    // If number of properties is different,
    // objects are not equivalent
    if(aProps.length != bProps.length) {
      return false;
    }

    if(Array.isArray(a) && Array.isArray(b)) {
      return Util.arrayEquals(a, b);
    }

    for(let i = 0; i < aProps.length; i++) {
      let propName = aProps[i];

      // If values of same property are not equal,
      // objects are not equivalent
      if(typeof a[propName] === 'object') {
        if(!Util.objArrayEquals(a[propName], b[propName])) {
          return false;
        }
      } else if(a[propName] !== b[propName]) {
        return false;
      }
    }

    // If we made it this far, objects
    // are considered equivalent
    return true;
  }

  static deepCopy(obj) {
    if(obj === undefined || obj === null || typeof(obj) !== 'object') {
      return obj;
    }

    if(Array.isArray(obj)) {
      return obj.map((e) => Util.deepCopy(e));
    }

    if(Buffer.isBuffer(obj)) {
      return new Buffer(obj);
    }

    let clone = {};
    for(let prop in obj) {
      if(obj.hasOwnProperty(prop)) {
        clone[prop] = Util.deepCopy(obj[prop]);
      }
    }

    return clone;
  }

  static serviceEndpointFrom(nodeId, hostname, address, port, role, zone, leaderSessionId) {
    return {nodeId: nodeId, hostname: hostname, address: address, port: port, role: role, zone: zone, leaderSessionId: leaderSessionId};
  }

  static deanonymizeAttributeValues(item, attrNames) {
    let attrValues = item._anonymousAttributeValues;

    // For projected attr lists (PutItem UPDATED_NEW/UPDATED_OLD) _anonymousAttributeValues is a sparse array
    // (i.e. if only 1 attribute is present the array would [, "value", ] or similar).
    // So we want to iterate over the present indices only
    // A rare case where for...in on an array is exactly what is needed
    for(let i in attrValues) {
      item[attrNames[i]] = attrValues[i];
    }

    delete item._anonymousAttributeValues;
    delete item._attrListId;
    return item;
  }

  static extractKey(item, tableKeys) {
    let keys = {};
    for(let keyDef of tableKeys) {
      let keyName = keyDef.AttributeName;
      keys[keyName] = item[keyName];
    }
    return keys;
  }
}

module.exports = Util;
