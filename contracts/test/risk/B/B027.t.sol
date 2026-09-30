// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BookSeamCases} from "./BookSeam.t.sol";

/// B027: runs the complete book-seam table (BookSeam.t.sol) through real B hooks with the mock
/// book and the scripted accounting double. Mock status: CP-BOOK mocked, Person A scripted.
contract B027Test is BookSeamCases {}
