pragma solidity ^0.8.30;

import {IMarketConfig} from "../interfaces/IMarketConfig.sol";
import {CollateralVault} from "../vaults/CollateralVault.sol";

interface IFactoryRegistry {
    function oracle() external view returns (address);
    function governance() external view returns (address);
}

contract MarketFactory {
    error Unauthorized();
    error InvalidDependency();
    error InvalidEngineCode();
    error InvalidListing();
    error UnsupportedEngineInit();
    error MarketExists();
    error DeploymentFailed();
    error ListingHashMismatch();

    address public immutable registry;
    address public immutable resolutionAuthority;
    address public immutable governance;
    address public immutable treasury;
    address public immutable codeStore;
    bytes32 public immutable codeStoreHash;
    bytes32 public immutable creationCodeHash;
    CollateralVault public immutable collateralVault;
    mapping(bytes32 marketId => address engine) public engineOf;

    event MarketDeployed(
        bytes32 indexed marketId, address indexed engine, address indexed vault, bytes32 listingHash
    );

    constructor(
        address registry_,
        address token,
        address treasury_,
        address codeStore_,
        bytes32 creationCodeHash_
    ) {
        if (registry_.code.length == 0 || token.code.length == 0 || treasury_ == address(0)) {
            revert InvalidDependency();
        }
        address authority = IFactoryRegistry(registry_).oracle();
        address governor = IFactoryRegistry(registry_).governance();
        if (authority.code.length == 0 || governor == address(0)) revert InvalidDependency();
        bytes memory stored = codeStore_.code;
        if (
            stored.length < 2 || stored.length > 131072 || stored[0] != bytes1(0)
                || creationCodeHash_ == bytes32(0)
        ) revert InvalidEngineCode();
        bytes32 actualHash;
        assembly ("memory-safe") {
            actualHash := keccak256(add(stored, 33), sub(mload(stored), 1))
        }
        if (actualHash != creationCodeHash_) revert InvalidEngineCode();
        registry = registry_;
        resolutionAuthority = authority;
        governance = governor;
        treasury = treasury_;
        codeStore = codeStore_;
        codeStoreHash = keccak256(stored);
        creationCodeHash = creationCodeHash_;
        collateralVault = new CollateralVault(token, address(this));
    }

    function deployMarket(IMarketConfig.Listing calldata listing, bytes calldata engineInit)
        external
        returns (address engine)
    {
        if (msg.sender != registry) revert Unauthorized();
        if (engineInit.length != 0) revert UnsupportedEngineInit();
        if (
            listing.marketId == bytes32(0) || listing.registry != registry
                || listing.resolutionAuthority != resolutionAuthority || listing.governance != governance
                || listing.token != address(collateralVault.token())
        ) revert InvalidListing();
        if (engineOf[listing.marketId] != address(0)) revert MarketExists();
        if (codeStore.codehash != codeStoreHash) revert InvalidEngineCode();
        uint256 codeLength = codeStore.code.length - 1;
        bytes memory creationCode = new bytes(codeLength);
        address storeAddress = codeStore;
        assembly ("memory-safe") {
            extcodecopy(storeAddress, add(creationCode, 32), 1, codeLength)
        }
        bytes memory initCode = bytes.concat(creationCode, abi.encode(collateralVault, treasury, listing));
        engineOf[listing.marketId] = address(1);
        assembly ("memory-safe") {
            engine := create(0, add(initCode, 32), mload(initCode))
            if iszero(engine) {
                let failure := mload(0x40)
                returndatacopy(failure, 0, returndatasize())
                revert(failure, returndatasize())
            }
        }
        if (engine.code.length == 0) revert DeploymentFailed();
        bytes32 expectedListingHash = keccak256(abi.encode(listing));
        if (IMarketConfig(engine).listingHash() != expectedListingHash) revert ListingHashMismatch();
        collateralVault.registerEngine(engine);
        engineOf[listing.marketId] = engine;
        emit MarketDeployed(listing.marketId, engine, address(collateralVault), expectedListingHash);
    }
}
