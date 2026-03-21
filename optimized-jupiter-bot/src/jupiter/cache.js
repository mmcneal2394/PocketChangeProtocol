"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedBlockhash = getCachedBlockhash;
exports.getAddressLookupTable = getAddressLookupTable;
var web3_js_1 = require("@solana/web3.js");
var config_1 = require("../utils/config");
var logger_1 = require("../utils/logger");
var cachedBlockhash = null;
var connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed', confirmTransactionInitialTimeout: 5000 });
var altCache = new Map();
function fetchRecentBlockhash() {
    return __awaiter(this, void 0, void 0, function () {
        var controller_1, timeout, response, data, e_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 3, , 4]);
                    controller_1 = new AbortController();
                    timeout = setTimeout(function () { return controller_1.abort(); }, 2500);
                    return [4 /*yield*/, fetch(config_1.config.RPC_ENDPOINT, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ "commitment": "confirmed" }] }),
                            signal: controller_1.signal
                        })];
                case 1:
                    response = _c.sent();
                    clearTimeout(timeout);
                    return [4 /*yield*/, response.json()];
                case 2:
                    data = _c.sent();
                    if ((_b = (_a = data === null || data === void 0 ? void 0 : data.result) === null || _a === void 0 ? void 0 : _a.value) === null || _b === void 0 ? void 0 : _b.blockhash) {
                        cachedBlockhash = data.result.value.blockhash;
                    }
                    else {
                        logger_1.logger.warn("RPC Failed Blockhash Fetch: " + JSON.stringify(data));
                    }
                    return [3 /*break*/, 4];
                case 3:
                    e_1 = _c.sent();
                    logger_1.logger.error("Failed to update recent blockhash: ".concat(e_1.message));
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
setInterval(fetchRecentBlockhash, 2000);
fetchRecentBlockhash();
function getCachedBlockhash() {
    if (!cachedBlockhash) {
        throw new Error("No cached blockhash available");
    }
    return cachedBlockhash;
}
function getAddressLookupTable(address_1) {
    return __awaiter(this, arguments, void 0, function (address, forceRefresh) {
        var pubkey, lookupTable, error_1;
        if (forceRefresh === void 0) { forceRefresh = false; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!forceRefresh && altCache.has(address)) {
                        return [2 /*return*/, altCache.get(address)];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    pubkey = new web3_js_1.PublicKey(address);
                    return [4 /*yield*/, connection.getAddressLookupTable(pubkey)];
                case 2:
                    lookupTable = _a.sent();
                    if (lookupTable.value) {
                        altCache.set(address, lookupTable.value);
                        return [2 /*return*/, lookupTable.value];
                    }
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _a.sent();
                    logger_1.logger.error("Failed to fetch ALT ".concat(address), error_1);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/, null];
            }
        });
    });
}
