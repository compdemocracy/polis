import React from "react";
import { Button, Flex, Text } from "theme-ui";

// don't use right now
const StatementButton = () => {
  return (
    <Button sx={{ backgroundColor: "transparent" }}>
      <Flex sx={{ alignItems: "center", columnGap: [2] }}>
        <svg
          fill="#2ecc71"
          viewBox="0 0 1792 1792"
          xmlns="http://www.w3.org/2000/svg"
          height="22px"
          width="22px"
        >
          <path d="M1299 813l-422 422q-19 19-45 19t-45-19l-294-294q-19-19-19-45t19-45l102-102q19-19 45-19t45 19l147 147 275-275q19-19 45-19t45 19l102 102q19 19 19 45t-19 45zm141 83q0-148-73-273t-198-198-273-73-273 73-198 198-73 273 73 273 198 198 273 73 273-73 198-198 73-273zm224 0q0 209-103 385.5t-279.5 279.5-385.5 103-385.5-103-279.5-279.5-103-385.5 103-385.5 279.5-279.5 385.5-103 385.5 103 279.5 279.5 103 385.5z" />
        </svg>
        <svg
          fill="#e74c3c"
          viewBox="0 0 1792 1792"
          xmlns="http://www.w3.org/2000/svg"
          height="22px"
          width="22px"
        >
          <path d="M1440 893q0-161-87-295l-754 753q137 89 297 89 111 0 211.5-43.5t173.5-116.5 116-174.5 43-212.5zm-999 299l755-754q-135-91-300-91-148 0-273 73t-198 199-73 274q0 162 89 299zm1223-299q0 157-61 300t-163.5 246-245 164-298.5 61-298.5-61-245-164-163.5-246-61-300 61-299.5 163.5-245.5 245-164 298.5-61 298.5 61 245 164 163.5 245.5 61 299.5z" />
        </svg>
        <Text sx={{ fontWeight: "400", fontSize: [1], color: "text" }}>Agree</Text>
      </Flex>
    </Button>
  );
};

export default StatementButton;
