// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceV2Base} from "./SurfaceV2Base.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {IMinter} from "../../../src/surface/v2/interfaces/IMinter.sol";

/// @dev A collection can observe the factory's registry during sale init.
contract RegistryObserverCollection {
    CloneFactory internal immutable factory;
    address internal immutable expectedSale;

    error RegisteredBeforeInitialization();

    constructor(CloneFactory factory_, address expectedSale_) {
        factory = factory_;
        expectedSale = expectedSale_;
    }

    function minter() external view returns (address) {
        if (factory.isInstance(msg.sender)) revert RegisteredBeforeInitialization();
        return expectedSale;
    }

    function owner() external pure returns (address) {
        return address(0);
    }
}

/// @notice Focused regression tests for behavior that survived mutation of
///         the original v2 suite.
contract MutationGuardsTest is SurfaceV2Base {
    function test_factory_doesNotExposeInstanceDuringInitialization() public {
        bytes32 salt = keccak256("registry callback");
        address predicted = saleFactory.predict(salt, address(this));
        RegistryObserverCollection collection = new RegistryObserverCollection(saleFactory, predicted);
        bytes memory init = abi.encodeCall(
            FixedPriceSale.initialize, (address(collection), PRICE, 0, 0, 0, 0, artist, address(0), pnd)
        );

        address instance = saleFactory.createDeterministic(salt, init);

        assertEq(instance, predicted);
        assertTrue(saleFactory.isInstance(instance));
        assertEq(FixedPriceSale(instance).collection(), address(collection));
    }

    function test_close_twiceRemainsClosed() public {
        (, FixedPriceSale sale) = _launch();

        vm.startPrank(artist);
        sale.close();
        sale.close();
        vm.stopPrank();

        assertTrue(sale.closed());
        vm.prank(collector);
        vm.expectRevert(IMinter.SaleClosed.selector);
        sale.mint{value: PRICE}(1);
    }
}
