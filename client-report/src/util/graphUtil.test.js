import graphUtil from "./graphUtil";
import createHull from "hull.js";

Object.defineProperty(window, 'd3', {
  writable: true,
});

// eslint-disable-next-line no-undef
global.window.d3 = {
  scaleLinear: jest.fn(() => {
    const mockScaleFunction = jest.fn((x) => x * 10); // Mock scale function that transforms input
    const mockScale = Object.assign(mockScaleFunction, {
      domain: jest.fn(() => mockScale), // Return the mockScale itself
      rangeRound: jest.fn(() => mockScale), // Return the mockScale itself
      range: jest.fn(() => mockScale), // Return the mockScale itself, not a function
      // Add other methods as needed (e.g., tickFormat)
    });
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
    expect(result.commentsPoints).toEqual([{ "tid": 1, "txt": "Comment 1", "x": 1, "y": 2 }]);
  });

  it("should calculate hulls for each group in baseClustersScaledAndGrouped", () => {
    const mockCreateHull = jest.fn().mockReturnValue("Mock Hull");
    createHull.mockImplementation(mockCreateHull); // Mock createHull behavior

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
      "group-clusters": [
        {
          id: 0,
          members: [100, 200, 300] // All base clusters belong to group 0
        }
      ],
    };
    const mockBadTids = {}; // No badTids

    graphUtil(mockComments, mockMath, mockBadTids);

    expect(mockCreateHull).toHaveBeenCalledTimes(1);
  });

  it("should handle sparse/empty data gracefully", () => {
    const result1 = graphUtil([], {}, {}); // Empty data
    expect(result1.commentsPoints).toEqual([]);
    expect(result1.baseClustersScaled).toEqual([]);
    expect(result1.hulls).toEqual([]);

    const result2 = graphUtil(null, null, null); // Null data
    expect(result2.commentsPoints).toEqual([]);
    expect(result2.baseClustersScaled).toEqual([]);
    expect(result2.hulls).toEqual([]);

    const result3 = graphUtil(
      [{ tid: 1, txt: "Comment 1" }],
      { pca: { "comment-projection": [[], []] }, tids: [] }, // Empty projections
      {}
    );
    expect(result3.commentsPoints).toEqual([]);
  });

  it("should not create hulls with insufficient points", () => {
    const mockCreateHull = jest.fn().mockReturnValue("Mock Hull");
    createHull.mockImplementation(mockCreateHull);

    const mockMath = {
      pca: { "comment-projection": [[1], [2]] },
      tids: [1, 2],
      "base-clusters": {
        x: [10, 20], // Only 2 points
        y: [40, 50],
        id: [100, 200],
      },
      "group-clusters": [
        {
          id: 0,
          members: [100, 200] // Only 2 base clusters (insufficient for hull)
        }
      ],
    };

    graphUtil([], mockMath, {});

    expect(mockCreateHull).toHaveBeenCalledTimes(0); // Should not create hull with < 3 points
  });
});