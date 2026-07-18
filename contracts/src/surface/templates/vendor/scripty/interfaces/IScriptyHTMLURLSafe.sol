// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

///////////////////////////////////////////////////////////
// ░██████╗░█████╗░██████╗░██╗██████╗░████████╗██╗░░░██╗ //
// ██╔════╝██╔══██╗██╔══██╗██║██╔══██╗╚══██╔══╝╚██╗░██╔╝ //
// ╚█████╗░██║░░╚═╝██████╔╝██║██████╔╝░░░██║░░░░╚████╔╝░ //
// ░╚═══██╗██║░░██╗██╔══██╗██║██╔═══╝░░░░██║░░░░░╚██╔╝░░ //
// ██████╔╝╚█████╔╝██║░░██║██║██║░░░░░░░░██║░░░░░░██║░░░ //
// ╚═════╝░░╚════╝░╚═╝░░╚═╝╚═╝╚═╝░░░░░░░░╚═╝░░░░░░╚═╝░░░ //
///////////////////////////////////////////////////////////

import {HTMLRequest, HTMLTagType, HTMLTag} from "./../core/ScriptyStructs.sol";

interface IScriptyHTMLURLSafe {
    // =============================================================
    //                      RAW HTML GETTERS
    // =============================================================

    /**
     * @notice  Get URL safe HTML with requested head tags and body tags
     * @dev Any tags with tagType = 1/script are converted to base64 and wrapped
     *      with <script src="data:text/javascript;base64,[SCRIPT]"></script>
     *
     *      [WARNING]: Large non-base64 libraries that need base64 encoding
     *      carry a high risk of causing a gas out. Highly advised the use
     *      of base64 encoded scripts where possible
     *
     *      Your HTML is returned in the following format:
     *
     *      <html>
     *          <head>
     *              [tagOpen[0]][contractRequest[0] | tagContent[0]][tagClose[0]]
     *              [tagOpen[1]][contractRequest[0] | tagContent[1]][tagClose[1]]
     *              ...
     *              [tagOpen[n]][contractRequest[0] | tagContent[n]][tagClose[n]]
     *          </head>
     *          <body>
     *              [tagOpen[0]][contractRequest[0] | tagContent[0]][tagClose[0]]
     *              [tagOpen[1]][contractRequest[0] | tagContent[1]][tagClose[1]]
     *              ...
     *              [tagOpen[n]][contractRequest[0] | tagContent[n]][tagClose[n]]
     *          </body>
     *      </html>
     * @param htmlRequest - HTMLRequest
     * @return Full HTML with head and body tags
     */
    function getHTMLURLSafe(
        HTMLRequest memory htmlRequest
    ) external view returns (bytes memory);

    // =============================================================
    //                      STRING UTILITIES
    // =============================================================

    /**
     * @notice Convert {getHTMLURLSafe} output to a string
     * @param htmlRequest - HTMLRequest
     * @return {getHTMLURLSafe} as a string
     */
    function getHTMLURLSafeString(
        HTMLRequest memory htmlRequest
    ) external view returns (string memory);
}
