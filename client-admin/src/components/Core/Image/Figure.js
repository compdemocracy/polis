import React from "react";

const Figure = ({ src, height, width, className }) => {
  return (
    <figure className={className}>
      <img src={src} height={height} />
    </figure>
  );
};

export default Figure;
