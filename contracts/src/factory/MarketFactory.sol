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
    address public immutable codeStoreTail;
    bytes32 public immutable codeStoreHash;
    bytes32 public immutable codeStoreTailHash;
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
        address codeStoreTail_,
        bytes32 creationCodeHash_
    ) {
        if (registry_.code.length == 0 || token.code.length == 0 || treasury_ == address(0)) {
            revert InvalidDependency();
        }
        address authority = IFactoryRegistry(registry_).oracle();
        address governor = IFactoryRegistry(registry_).governance();
        if (authority.code.length == 0 || governor == address(0)) revert InvalidDependency();
        _checkStore(codeStore_);
        if (codeStoreTail_ != address(0)) _checkStore(codeStoreTail_);
        bytes memory stored = _readCode(codeStore_, codeStoreTail_);
        if (creationCodeHash_ == bytes32(0) || keccak256(stored) != creationCodeHash_) revert InvalidEngineCode();
        registry = registry_;
        resolutionAuthority = authority;
        governance = governor;
        treasury = treasury_;
        codeStore = codeStore_;
        codeStoreTail = codeStoreTail_;
        codeStoreHash = codeStore_.codehash;
        codeStoreTailHash = codeStoreTail_.codehash;
        creationCodeHash = creationCodeHash_;
        collateralVault = new CollateralVault(token, address(this));
    }

    function _checkStore(address store) private view {
        bytes memory data = store.code;
        if (data.length < 2 || data.length > 131072 || data[0] != bytes1(0)) revert InvalidEngineCode();
    }

    /// @dev At most two STOP-prefixed immutable chunks; no callable initializer or delegatecall.
    function _readCode(address first, address second) private view returns (bytes memory code) {
        uint256 firstLength = first.code.length - 1;
        uint256 secondLength = second == address(0) ? 0 : second.code.length - 1;
        code = new bytes(firstLength + secondLength);
        assembly ("memory-safe") {
            extcodecopy(first, add(code, 32), 1, firstLength)
            if secondLength { extcodecopy(second, add(add(code, 32), firstLength), 1, secondLength) }
        }
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
        if (codeStore.codehash != codeStoreHash || (codeStoreTail != address(0) && codeStoreTail.codehash != codeStoreTailHash)) revert InvalidEngineCode();
        bytes memory creationCode = _readCode(codeStore, codeStoreTail);
        bytes memory initCode = bytes.concat(creationCode, abi.encode(collateralVault, treasury, listing));
        if (initCode.length > 262144) revert InvalidEngineCode();
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
