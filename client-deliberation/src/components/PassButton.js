import React from "react";
import { Button } from "theme-ui";

const PassButton = ({ vote }) => {
  return (
    <Button
      variant="vote"
      onClick={() => {
        var o = {
          vote: 0, //pass
        };
        return vote(o);
      }}
    >
      Pass / Unsure
    </Button>
  );
};

export default PassButton;
