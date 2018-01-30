import React from 'react'
import PropTypes from 'prop-types'
import classnames from 'classnames'
import Figure from "../../Core/Image/Figure";

import PolisReportImage from "../Icons/polis-report-insights.png";


const Hero = ({ headline, subheadline, className }) => {
  return <header className={classnames("mb2", "mb3-m", "mb4-l", "pv4", className)}>
      <div className="flex flex-column flex-row-l ph4 justify-center">
        <div className="w40 measure mr4">
          <h1 className="f2 f1-ns ttc bodoni lh-solid lh-title-ns  mt4 mb3">{headline}</h1>
          <p className="f4 f3-ns mb4 lh-copy">{subheadline}</p>
          <a href="/demo/" className="br3 ba ph4 pv3 mb3 dib tc ttu fw6 bg-blue white justify-center link">
            Get Started
          </a>
          <p>
            Already using Polis?
            <a href="/signin" className="link ml2">
              Sign In
            </a>
          </p>
          </div>
        <Figure src={PolisReportImage} width="600px" className="w9 mt4 mt3-l"  />
      </div>
    </header>;
}

Hero.propTypes = {
  headline: PropTypes.string.isRequired,
  subheadline: PropTypes.string.isRequired,
  className: PropTypes.string,
}

export default Hero
