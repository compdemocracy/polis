import React from "react";
import PropTypes from "prop-types";
import classnames from "classnames";
import Figure from '../../Core/Image/Figure'

import CanadaLogo from '../icons/canada.png'
import ColumbiaULogo from "../icons/columbia.png"
import MarchOnLogo from "../icons/marchon.png"


const Trust = ({ headline, subheadline, className }) => {
  return <section className={classnames("mb2", "mb3-m", "mb4-l", "ph3", "pv4", "bg-light-blue", className)}>
      <header className="ph4 tc-ns center">
        <h2 className="f2 ttc bodoni lh-solid lh-title-m  mb3 ">{headline}</h2>
        <p className="f4 f3-l mb4 measure center lh-copy">{subheadline}</p>
      </header>

      <div className="flex flex-wrap justify-center">
        <Figure src={ColumbiaULogo} height="80px" className="client-logos w4 h4 mh3 mb2 br-100 bg-white" />
        <Figure src={CanadaLogo} height="30px" className="client-logos w4 h4 mh3 mb2 br-100 bg-white" />
        <Figure src={MarchOnLogo} height="80px" className="client-logos w4 h4 mh3 mb2 br-100 bg-white" />
      </div>
    </section>;
};

Trust.propTypes = {
  headline: PropTypes.string.isRequired,
  subheadline: PropTypes.string.isRequired,
  className: PropTypes.string
};

export default Trust;
