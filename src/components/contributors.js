import React from "react";
import Radium from "radium";
import Awesome from "react-fontawesome";
import StaticContentContainer from "./framework/static-content-container";
import Button from "./framework/generic-button";

// import _ from "lodash";
import Flex from "./framework/flex";
// import { connect } from "react-redux";
// import { FOO } from "../actions";


// @connect(state => {
//   return state.FOO;
// })
@Radium
class ComponentName extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    // dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  getStyles() {
    return {
      base: {

      },
      input: {
        display: "block",
        margin: "10px 0px",
        color: "rgb(100,100,100)",
        width: "40%",
        fontSize: 14,
        padding: 7,
        borderRadius: 3,
        border: "1px solid rgb(130,130,130)",
      },
      heading: {
        fontSize: 36,
        display: "block",
        marginBottom: 20,
        marginTop: 0
      },
      card: {
        position: "relative",
        zIndex: 10,
        maxWidth: 600,
        padding: 20,
        borderRadius: 3,
        color: "rgb(130,130,130)"
      },
      button: {
        display: "block",
        backgroundColor: "#03a9f4",
        color: "white"
      },
      agreement: {
        width: 600,
        height: 150,
        borderRadius: 3,
        border: "1px solid rgb(130,130,130)",
        resize: "none",
        padding: "0px 20px 20px 20px",
        color: "rgb(100,100,100)",
        fontFamily: "Georgia, serif",
        marginBottom: 20,
      }
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <StaticContentContainer
        backgroundColor={"#03a9f4"}
        headerBackgroundColor={"#03a9f4"}
        footerBackgroundColor={"#03a9f4"}
        image={false}>
        <Flex>
          <div style={styles.card}>
            <p style={styles.heading}>
              <Awesome name={"code"} /> Pol.is Contributor Agreement
            </p>
            <p>
              {`
                You are welcome to fork and hack on any pol.is repository.
                If you want to contribute back to our company's repositories, you'll need
                to complete the Contributor Agreement below.
                You only need to complete this form once to contribute to all pol.is repositories.
              `}
            </p>
            <Flex
              wrap="wrap"
              justifyContent="space-between">
              <input
                style={styles.input}
                type="text"
                placeholder="Name"
                ref="name"/>
              <input
                style={styles.input}
                type="email"
                placeholder="Email"
                ref="email"/>
              <input
                style={styles.input}
                type="text"
                placeholder="Github Username"
                ref="github_username"/>
              <input
                style={styles.input}
                type="text"
                placeholder="Company name (if applicable)"
                ref="company_name"/>
              <input
                style={styles.input}
                type="text"
                value={new Date()}
                ref="date"/>
            </Flex>
            <textarea style={styles.agreement} readOnly>
              {`
                This Polis Contributor Agreement (“PCA”) applies to any contribution that you make to any product or project managed by us (the “project”), and sets out the intellectual property rights you grant to us in the contributed materials. The term “us” shall mean Polis Technology Inc. The term “you” shall mean the person or entity identified below. If you agree to be bound by these terms, fill in the information requested below and sign the PCA where indicated below. Read this agreement carefully before signing. These terms and conditions constitute a binding legal agreement.

                1. The term 'contribution' or ‘contributed materials’ means any source code, object code, patch, tool, sample, graphic, specification, manual, documentation, or any other material posted or submitted by you to the project.

                2. With respect to any worldwide copyrights, or copyright applications and registrations, in your contribution:
                  - you hereby assign to us joint ownership, and to the extent that such assignment is or becomes invalid, ineffective or unenforceable, you hereby grant to us a perpetual, irrevocable, non-exclusive, worldwide, no-charge, royalty-free, unrestricted license to exercise all rights under those copyrights. This includes, at our option, the right to sublicense these same rights to third parties through multiple levels of sublicensees or other licensing arrangements;
                  - you agree that each of us can do all things in relation to your contribution as if each of us were the sole owners, and if one of us makes a derivative work of your contribution, the one who makes the derivative work (or has it made) will be the sole owner of that derivative work;
                  - you agree that you will not assert any moral rights in your contribution against us, our licensees or transferees;
                  - you agree that we may register a copyright in your contribution and exercise all ownership rights associated with it; and
                  - you agree that neither of us has any duty to consult with, obtain the consent of, pay or render an accounting to the other for any use or distribution of your contribution.

                3. With respect to any patents you own, or that you can license without payment to any third party, you hereby grant to us a perpetual, irrevocable, non-exclusive, worldwide, no-charge, royalty-free license to:
                  - make, have made, use, sell, offer to sell, import, and otherwise transfer your contribution in whole or in part, alone or in combination with or included in any product, work or materials arising out of the project to which your contribution was submitted, and
                  - at our option, to sublicense these same rights to third parties through multiple levels of sublicensees or other licensing arrangements.

                4. Except as set out above, you keep all right, title, and interest in your contribution. The rights that you grant to us under these terms are effective on the date you first submitted a contribution to us, even if your submission took place before the date you sign these terms. Any contribution we make available under any license will also be made available under a suitable FSF (Free Software Foundation) or OSI (Open Source Initiative) approved license.

                5. You covenant, represent, warrant and agree that:
                  - each contribution that you submit is and shall be an original work of authorship and you can legally grant the rights set out in this PCA;
                  - to the best of your knowledge, each contribution will not violate any third party's copyrights, trademarks, patents, or other intellectual property rights; and
                  - each contribution shall be in compliance with U.S. export control laws and other applicable export and import laws.

                You agree to notify us if you become aware of any circumstance which would make any of the foregoing representations inaccurate in any respect. Polis may publicly disclose your participation in the project, including the fact that you have signed the PCA.

                6. This PCA is governed by the laws of the State of California and applicable U.S. Federal law. Any choice of law rules will not apply.
              `}
            </textarea>
            <Button style={styles.button}>
              I Agree
            </Button>
          </div>
        </Flex>
      </StaticContentContainer>
    );
  }
}

export default ComponentName;
