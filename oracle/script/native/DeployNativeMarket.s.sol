// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {NativeOutcomeVault} from "@eros/native/NativeOutcomeVault.sol";

/// @notice Kuru Router market creation (kuru-sdk abi/Router.json). Type 0 = NO_NATIVE (ERC-20/ERC-20).
interface IKuruRouter {
    function deployProxy(
        uint8 marketType,
        address baseAsset,
        address quoteAsset,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 kuruAmmSpread
    ) external returns (address orderBook);
}

/// @title DeployNativeMarket (NM-D02 / NM-D03)
/// @notice Step 1 of the native listing: deploy the outcome vault (which creates YES/NO) and the
///         YES/collateral and NO/collateral Kuru books. It does NOT list the event or bind the vault:
///         the native INDEX rules hash commits to these addresses, so the listing (existing
///         ListMarket, lister key) follows, then the permissionless `bindMarket()`.
///         Refuses to run if the output file exists, so a rerun cannot duplicate funded contracts.
///
///   NATIVE_PARAMS=deployments/native/<name>.params.json \
///   forge script script/native/DeployNativeMarket.s.sol --rpc-url $RPC --broadcast --private-key $KEY
///
/// Params JSON: registry, marketId, collateral, rules (exact event rules text), scheduledT,
/// issuanceCap (atoms), yesSymbol, noSymbol, kuruRouter, kuru{pricePrecision, sizePrecision,
/// tickSize, minSize, maxSize, takerFeeBps, makerFeeBps, ammSpread}, out (output path).
contract DeployNativeMarket is Script {
    using stdJson for string;

    struct Out {
        address vault;
        address yes;
        address no;
        address yesBook;
        address noBook;
    }

    function run() external returns (Out memory o) {
        string memory p = vm.readFile(vm.envString("NATIVE_PARAMS"));
        string memory outPath = p.readString(".out");
        require(!vm.exists(outPath), "NATIVE_DEPLOYMENT_EXISTS");
        bytes32 rulesHash = keccak256(bytes(p.readString(".rules")));
        address collateral = p.readAddress(".collateral");
        IKuruRouter router = IKuruRouter(p.readAddress(".kuruRouter"));
        require(address(router).code.length != 0, "KURU_ROUTER_NOT_DEPLOYED");

        vm.startBroadcast();
        NativeOutcomeVault vault = new NativeOutcomeVault(
            p.readAddress(".registry"),
            p.readBytes32(".marketId"),
            collateral,
            rulesHash,
            uint64(p.readUint(".scheduledT")),
            p.readUint(".issuanceCap"),
            p.readString(".yesSymbol"),
            p.readString(".noSymbol")
        );
        o.vault = address(vault);
        o.yes = address(vault.yes());
        o.no = address(vault.no());
        o.yesBook = _book(router, p, o.yes, collateral);
        o.noBook = _book(router, p, o.no, collateral);
        vm.stopBroadcast();

        string memory k = "native";
        k.serialize("chainId", block.chainid);
        k.serialize("registry", p.readAddress(".registry"));
        k.serialize("marketId", p.readBytes32(".marketId"));
        k.serialize("collateral", collateral);
        k.serialize("erosRulesHash", rulesHash);
        k.serialize("scheduledT", p.readUint(".scheduledT"));
        k.serialize("issuanceCap", p.readUint(".issuanceCap"));
        k.serialize("kuruRouter", address(router));
        k.serialize("outcomeVault", o.vault);
        k.serialize("yesToken", o.yes);
        k.serialize("noToken", o.no);
        k.serialize("noBook", o.noBook);
        k.serialize("vaultCodehash", o.vault.codehash);
        string memory json = k.serialize("yesBook", o.yesBook);
        vm.writeJson(json, outPath);
        console2.log("vault", o.vault);
        console2.log("yesBook", o.yesBook);
        console2.log("noBook", o.noBook);
    }

    struct KuruParams {
        uint96 sizePrecision;
        uint32 pricePrecision;
        uint32 tickSize;
        uint96 minSize;
        uint96 maxSize;
        uint256 takerFeeBps;
        uint256 makerFeeBps;
        uint96 ammSpread;
    }

    function _kuru(string memory p) internal pure returns (KuruParams memory k) {
        k.sizePrecision = uint96(p.readUint(".kuru.sizePrecision"));
        k.pricePrecision = uint32(p.readUint(".kuru.pricePrecision"));
        k.tickSize = uint32(p.readUint(".kuru.tickSize"));
        k.minSize = uint96(p.readUint(".kuru.minSize"));
        k.maxSize = uint96(p.readUint(".kuru.maxSize"));
        k.takerFeeBps = p.readUint(".kuru.takerFeeBps");
        k.makerFeeBps = p.readUint(".kuru.makerFeeBps");
        k.ammSpread = uint96(p.readUint(".kuru.ammSpread"));
    }

    function _book(IKuruRouter router, string memory p, address base, address quote) internal returns (address) {
        KuruParams memory k = _kuru(p);
        return router.deployProxy(
            0, base, quote, k.sizePrecision, k.pricePrecision, k.tickSize, k.minSize, k.maxSize, k.takerFeeBps,
            k.makerFeeBps, k.ammSpread
        );
    }
}
