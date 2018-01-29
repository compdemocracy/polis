import React from "react";
import PropTypes from "prop-types";
import classnames from "classnames";
import PropItem from "../../Core/Prop/PropItem";

import EasyIcon from "../Icons/easy-to-start.svg";
import ParticipationIcon from "../Icons/participation-engagement.svg";
import AIIcon from "../Icons/ai-insights.svg";
import AIInsightsIcon from "../Icons/ai-powered-insights.svg";

const localData = {
  values: {
    headline: "Our mission is to help people understand each other",
    props: [
      {
        src: `${EasyIcon}`,
        headline: "Easy to get started",
        teaser: "Create a conversation in minutes, see results in under an hour."
      },
      {
        src: `${ParticipationIcon}`,
        headline: "Higher engagement",
        teaser:
          "Encourages higher participation and engagement than traditional surveys, by giving participants a chance to hear and be heard."
      },
      {
        src: `${AIInsightsIcon}`,
        headline: "Unique Insights",
        teaser: "Get rich feedback from participants in a real-time report."
      },
      {
        src: `${AIIcon}`,
        headline: "AI-enabled analytics",
        teaser:
          "Polis clusters participants to define the opinion landscape, identifying points of consensus and divergence."
      }
    ]
  }
};

const FeatureSection = ({ data }) => {
  return <section className={classnames("mb2", "mb3-m", "mb4-l", "ph3", "pv4","center", "mw8")}>
      <header className="ph4 mw7 center tc">
        <h2 className="f2 ttc bodoni lh-title  mb5 ">
          { localData.values.headline }
        </h2>
      </header>

      <div className="flex flex-column flex-row-ns flex-wrap-ns mw7-ns center ph4-ns">
        {localData.values.props.map(item => (
          <PropItem
            src={item.src}
            headline={item.headline}
            teaser={item.teaser}
          />
        ))}
      </div>
    </section>;
};

FeatureSection.propTypes = {
  // data: PropTypes.object.isRequired
};

export default FeatureSection;
