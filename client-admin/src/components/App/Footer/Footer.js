import React from "react";
import { SocialIcon } from "tachyons-react-social-icons";

import Logo from "../../Core/Logo/Logo";
import ListItem from "../../Core/List/ListItem";

const Footer = ({ social, content, data }) => {
  const date = new Date();
  const currentYear = date.getFullYear();

  return (
    <footer role="contentinfo" className="bg-blue white">
      <div className="mw9 center pl3 pl4-ns pr4 pr6-l pt4 pb5 mt5 flex flex-column flex-row-ns justify-between items-start cb">
        <Logo width="60px" height="32px" />

        {content.map((group, i) => (
          <div key={group.heading}>
            <h4 className="f5 white mb3 fw4 ttu">{group.heading}</h4>
            <ul className="list mb4">
              {group.links.map((link, i) => (
                <ListItem key={i} className="f6 mb3">
                  <a href={link.url} className="white link">
                    {link.title}
                  </a>
                </ListItem>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="f6 w-100 w-auto-ns bg-dark-blue flex justify-end items-center ph3 ph4-ns pv3">
        <div className="mw9 center">
          <p className="mra white mb3">
            &copy; {currentYear} {data.copyright}
          </p>
          {social.map((url, i) => (
            <SocialIcon key={`icon-${i}`} url={url} color="white" className="mr3" />
          ))}
        </div>
      </div>
    </footer>
  );
};

export default Footer;
