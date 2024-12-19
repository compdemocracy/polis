import graphUtil from "./graphUtil";
import createHull from "hull.js";
import * as d3contour from "d3-contour";
import * as d3chromatic from "d3-scale-chromatic";
import * as d3geo from "d3-geo";

Object.defineProperty(window, 'd3', {
  writable: true,
});

global.window.d3 = {
  scaleLinear: jest.fn(() => {
    const mockScale = { // Create a mock scale object
      domain: jest.fn(() => mockScale), // Return the mockScale itself
      rangeRound: jest.fn(() => mockScale), // Return the mockScale itself
      range: jest.fn(() => jest.fn()), // Add range for completeness
      // Add other methods as needed (e.g., tickFormat)
    };
    return mockScale; // Return the mock scale object
  }),
  geoPath: jest.fn(() => jest.fn()),
  extent: jest.fn(() => [0, 1]), // Mock extent to return a default range
  forceSimulation: jest.fn().mockReturnValue({
    force: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    tick: jest.fn()
  }),
  forceX: jest.fn().mockReturnValue({  // Add a mock return for forceX
    strength: jest.fn().mockReturnThis() // Add a mock for strength
  }),
  forceY: jest.fn(),
  forceCollide: jest.fn(),
  voronoi: jest.fn().mockReturnValue({
    extent: jest.fn().mockReturnThis(),
    x: jest.fn().mockReturnThis(),
    y: jest.fn().mockReturnThis(),
    polygons: jest.fn().mockReturnValue([
      {
        join: jest.fn(),
        data: {}
      },
    ])
  })
}

import * as d3 from 'd3';

jest.mock("hull.js"); // Mock createHull for isolation

describe("graphUtil", () => {
  it("should calculate commentsPoints with proper filtering", () => {
    const mockComments = [
      { tid: 1, txt: "Comment 1" },
      { tid: 2, txt: "Comment 2" },
      { tid: 4, txt: "Comment 4" },
    ];
    const mockMath = {
        pca: { "comment-projection": [[1], [2], [4]] },
        tids: [1, 2, 4],
        "base-clusters": {
          x: [10, 20, 30],
          y: [40, 50, 60],
          id: [100, 200, 300],
        },
        "group-clusters": [],
      };
    const mockBadTids = {}; // No badTids

    const result = graphUtil(mockComments, mockMath, mockBadTids);

    expect(result.commentsPoints.length).toBe(1); // Only 2 comments after filtering
    expect(result.commentsPoints).toEqual([{"tid": 1, "txt": "Comment 1", "x": 1, "y": 2}]);
  });

  it("should calculate hulls for each group in baseClustersScaledAndGrouped", () => {
    const mockCreateHull = jest.fn().mockReturnValue("Mock Hull");
    createHull.mockImplementation(mockCreateHull); // Mock createHull behavior

    const mockBaseClustersScaledAndGrouped = {
      group1: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      group2: [{ x: 5, y: 6 }],
    };

    const mockComments = [
        { tid: 1, txt: "Comment 1" },
        { tid: 2, txt: "Comment 2" },
        { tid: 4, txt: "Comment 4" },
    ];

    const mockMath = {
        pca: { "comment-projection": [[1], [2], [4]] },
        tids: [1, 2, 4],
        "base-clusters": {
          x: [10, 20, 30],
          y: [40, 50, 60],
          id: [100, 200, 300],
        },
        "group-clusters": [],
      };
    const mockBadTids = {}; // No badTids

    const result = graphUtil(mockComments, mockMath, mockBadTids);

    expect(mockCreateHull).toHaveBeenCalledTimes(1);
  });
});