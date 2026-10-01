// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract MockUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public blocked;
    bool public taxed;
    address public callback;
    bytes public callbackData;

    function mint(address owner, uint256 atoms) external {
        balanceOf[owner] += atoms;
    }

    function approve(address spender, uint256 atoms) external returns (bool) {
        allowance[msg.sender][spender] = atoms;
        return true;
    }

    function transfer(address to, uint256 atoms) external returns (bool) {
        _move(msg.sender, to, atoms);
        return true;
    }

    function transferFrom(address from, address to, uint256 atoms) external returns (bool) {
        allowance[from][msg.sender] -= atoms;
        _move(from, to, atoms);
        return true;
    }

    function configure(address blocked_, bool taxed_) external {
        blocked = blocked_;
        taxed = taxed_;
    }

    function setCallback(address target, bytes memory data) external {
        callback = target;
        callbackData = data;
    }

    function _move(address from, address to, uint256 atoms) private {
        require(to != blocked, "blocked recipient");
        if (callback != address(0)) {
            (bool ok,) = callback.call(callbackData);
            require(ok, "callback rejected");
        }
        balanceOf[from] -= atoms;
        balanceOf[to] += atoms - (taxed && atoms > 0 ? 1 : 0);
    }
}
