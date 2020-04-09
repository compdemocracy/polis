import React from "react";
import PropTypes from "prop-types";

const CTA = ({ headline }) => {
  return (
    <aside className="ph4 pv4 pv2-ns flex-ns justify-center items-center b--light-blue bt">
      <div className="mw6">
        <h3 className="f3 mb1 mw5 lh-title">Find out why so many organizations use Polis</h3>
      </div>
      <div className="mla mt3 mt0-ns">
        <a href="/demo/" className="br3 ba ph4 pv3 dib tc ttu fw6 bg-blue white justify-center link">
          Request a demo
        </a>
      </div>
    </aside>
  );
};

CTA.propTypes = {
  headline: PropTypes.any.isRequired,
};

export default CTA;
