// Contains code derived from hull.js (Andrii Heonia, BSD-3-Clause) and
// robust-* utilities by Mikola Lysenko (MIT). See THIRD_PARTY_LICENSES.md
// for the original license texts and attribution details.

type Point = [number, number]
type Bbox = [number, number, number, number]

const EPSILON = 1.1102230246251565e-16
const ERRBOUND3 = (3.0 + 16.0 * EPSILON) * EPSILON
const SPLITTER = Math.pow(2, 27) + 1.0

function twoProduct(a: number, b: number, result?: number[]): number[] {
    const x = a * b

    const c = SPLITTER * a
    const abig = c - a
    const ahi = c - abig
    const alo = a - ahi

    const d = SPLITTER * b
    const bbig = d - b
    const bhi = d - bbig
    const blo = b - bhi

    const err1 = x - ahi * bhi
    const err2 = err1 - alo * bhi
    const err3 = err2 - ahi * blo

    const y = alo * blo - err3

    if (result) {
        result[0] = y
        result[1] = x
        return result
    }

    return [y, x]
}

function scalarScalarSum(a: number, b: number): number[] {
    const x = a + b
    const bv = x - a
    const av = x - bv
    const br = b - bv
    const ar = a - av
    const y = ar + br
    if (y) {
        return [y, x]
    }
    return [x]
}

function robustSum(e: number[], f: number[]): number[] {
    const ne = e.length | 0
    const nf = f.length | 0
    if (ne === 1 && nf === 1) {
        return scalarScalarSum(e[0], f[0])
    }
    const n = ne + nf
    const g = new Array<number>(n)
    let count = 0
    let eptr = 0
    let fptr = 0
    const abs = Math.abs
    let ei = e[eptr]
    let ea = abs(ei)
    let fi = f[fptr]
    let fa = abs(fi)
    let a: number
    let b: number
    if (ea < fa) {
        b = ei
        eptr += 1
        if (eptr < ne) {
            ei = e[eptr]
            ea = abs(ei)
        }
    } else {
        b = fi
        fptr += 1
        if (fptr < nf) {
            fi = f[fptr]
            fa = abs(fi)
        }
    }
    if ((eptr < ne && ea < fa) || fptr >= nf) {
        a = ei
        eptr += 1
        if (eptr < ne) {
            ei = e[eptr]
            ea = abs(ei)
        }
    } else {
        a = fi
        fptr += 1
        if (fptr < nf) {
            fi = f[fptr]
            fa = abs(fi)
        }
    }
    let x = a + b
    let bv = x - a
    let y = b - bv
    let q0 = y
    let q1 = x
    let _x: number
    let _bv: number
    let _av: number
    let _br: number
    let _ar: number
    while (eptr < ne && fptr < nf) {
        if (ea < fa) {
            a = ei
            eptr += 1
            if (eptr < ne) {
                ei = e[eptr]
                ea = abs(ei)
            }
        } else {
            a = fi
            fptr += 1
            if (fptr < nf) {
                fi = f[fptr]
                fa = abs(fi)
            }
        }
        b = q0
        x = a + b
        bv = x - a
        y = b - bv
        if (y) {
            g[count++] = y
        }
        _x = q1 + x
        _bv = _x - q1
        _av = _x - _bv
        _br = x - _bv
        _ar = q1 - _av
        q0 = _ar + _br
        q1 = _x
    }
    while (eptr < ne) {
        a = ei
        b = q0
        x = a + b
        bv = x - a
        y = b - bv
        if (y) {
            g[count++] = y
        }
        _x = q1 + x
        _bv = _x - q1
        _av = _x - _bv
        _br = x - _bv
        _ar = q1 - _av
        q0 = _ar + _br
        q1 = _x
        eptr += 1
        if (eptr < ne) {
            ei = e[eptr]
        }
    }
    while (fptr < nf) {
        a = fi
        b = q0
        x = a + b
        bv = x - a
        y = b - bv
        if (y) {
            g[count++] = y
        }
        _x = q1 + x
        _bv = _x - q1
        _av = _x - _bv
        _br = x - _bv
        _ar = q1 - _av
        q0 = _ar + _br
        q1 = _x
        fptr += 1
        if (fptr < nf) {
            fi = f[fptr]
        }
    }
    if (q0) {
        g[count++] = q0
    }
    if (q1) {
        g[count++] = q1
    }
    if (!count) {
        g[count++] = 0.0
    }
    g.length = count
    return g
}

function scalarScalarDiff(a: number, b: number): number[] {
    const x = a + b
    const bv = x - a
    const av = x - bv
    const br = b - bv
    const ar = a - av
    const y = ar + br
    if (y) {
        return [y, x]
    }
    return [x]
}

function robustSubtract(e: number[], f: number[]): number[] {
    const ne = e.length | 0
    const nf = f.length | 0
    if (ne === 1 && nf === 1) {
        return scalarScalarDiff(e[0], -f[0])
    }
    const n = ne + nf
    const g = new Array<number>(n)
    let count = 0
    let eptr = 0
    let fptr = 0
    const abs = Math.abs
    let ei = e[eptr]
    let ea = abs(ei)
    let fi = -f[fptr]
    let fa = abs(fi)
    let a: number
    let b: number
    if (ea < fa) {
        b = ei
        eptr += 1
        if (eptr < ne) {
            ei = e[eptr]
            ea = abs(ei)
        }
    } else {
        b = fi
        fptr += 1
        if (fptr < nf) {
            fi = -f[fptr]
            fa = abs(fi)
        }
    }
    if ((eptr < ne && ea < fa) || fptr >= nf) {
        a = ei
        eptr += 1
        if (eptr < ne) {
            ei = e[eptr]
            ea = abs(ei)
        }
    } else {
        a = fi
        fptr += 1
        if (fptr < nf) {
            fi = -f[fptr]
            fa = abs(fi)
        }
    }
    let x = a + b
    let bv = x - a
    let y = b - bv
    let q0 = y
    let q1 = x
    let _x: number
    let _bv: number
    let _av: number
    let _br: number
    let _ar: number
    while (eptr < ne && fptr < nf) {
        if (ea < fa) {
            a = ei
            eptr += 1
            if (eptr < ne) {
                ei = e[eptr]
                ea = abs(ei)
            }
        } else {
            a = fi
            fptr += 1
            if (fptr < nf) {
                fi = -f[fptr]
                fa = abs(fi)
            }
        }
        b = q0
        x = a + b
        bv = x - a
        y = b - bv
        if (y) {
            g[count++] = y
        }
        _x = q1 + x
        _bv = _x - q1
        _av = _x - _bv
        _br = x - _bv
        _ar = q1 - _av
        q0 = _ar + _br
        q1 = _x
    }
    while (eptr < ne) {
        a = ei
        b = q0
        x = a + b
        bv = x - a
        y = b - bv
        if (y) {
            g[count++] = y
        }
        _x = q1 + x
        _bv = _x - q1
        _av = _x - _bv
        _br = x - _bv
        _ar = q1 - _av
        q0 = _ar + _br
        q1 = _x
        eptr += 1
        if (eptr < ne) {
            ei = e[eptr]
        }
    }
    while (fptr < nf) {
        a = fi
        b = q0
        x = a + b
        bv = x - a
        y = b - bv
        if (y) {
            g[count++] = y
        }
        _x = q1 + x
        _bv = _x - q1
        _av = _x - _bv
        _br = x - _bv
        _ar = q1 - _av
        q0 = _ar + _br
        q1 = _x
        fptr += 1
        if (fptr < nf) {
            fi = -f[fptr]
        }
    }
    if (q0) {
        g[count++] = q0
    }
    if (q1) {
        g[count++] = q1
    }
    if (!count) {
        g[count++] = 0.0
    }
    g.length = count
    return g
}

type ExpansionOp = (a: number[], b: number[]) => number[]
type ProductOp = (a: number, b: number, result?: number[]) => number[]
type SubtractOp = (e: number[], f: number[]) => number[]

function orientationExact(
    sum: ExpansionOp,
    prod: ProductOp,
    sub: SubtractOp,
): (m0: number[], m1: number[], m2: number[]) => number {
    return function orientation3Exact(m0: number[], m1: number[], m2: number[]): number {
        const p = sum(
            sum(prod(m1[1], m2[0]), prod(-m2[1], m1[0])),
            sum(prod(m0[1], m1[0]), prod(-m1[1], m0[0])),
        )
        const n = sum(prod(m0[1], m2[0]), prod(-m2[1], m0[0]))
        const d = sub(p, n)
        return d[d.length - 1]
    }
}

const orientation3Exact = orientationExact(robustSum, twoProduct, robustSubtract)

function orientation3(a: number[], b: number[], c: number[]): number {
    const l = (a[1] - c[1]) * (b[0] - c[0])
    const r = (a[0] - c[0]) * (b[1] - c[1])
    const det = l - r

    let s: number
    if (l > 0) {
        if (r <= 0) {
            return det
        }
        s = l + r
    } else if (l < 0) {
        if (r >= 0) {
            return det
        }
        s = -(l + r)
    } else {
        return det
    }

    const tol = ERRBOUND3 * s
    if (det >= tol || det <= -tol) {
        return det
    }

    return orientation3Exact(a, b, c)
}

const MAX_CONCAVE_ANGLE_COS = Math.cos(90 / (180 / Math.PI)) // angle = 90 deg
const MAX_SEARCH_BBOX_SIZE_PERCENT = 0.6

/**
 * Grid data structure for point storage and retrieval.
 */
class PointGrid {
    private _cells: (Point[] | undefined)[][] = []
    private _cellSize: number
    private _reverseCellSize: number

    constructor(points: Point[], cellSize: number) {
        this._cellSize = cellSize > 0 ? cellSize : 1
        this._reverseCellSize = 1 / this._cellSize

        for (let i = 0; i < points.length; i++) {
            const point = points[i]
            const x = this.coordToCellNum(point[0])
            const y = this.coordToCellNum(point[1])
            if (!this._cells[x]) {
                const array: (Point[] | undefined)[] = []
                array[y] = [point]
                this._cells[x] = array
            } else if (!this._cells[x]![y]) {
                this._cells[x]![y] = [point]
            } else {
                this._cells[x]![y]!.push(point)
            }
        }
    }

    private cellPoints(x: number, y: number): Point[] {
        return (this._cells[x] !== undefined && this._cells[x]![y] !== undefined) ? this._cells[x]![y]! : []
    }

    private coordToCellNum(value: number): number {
        return Math.trunc(value * this._reverseCellSize)
    }

    /**
     * Returns all points within a given bounding box.
     * @param bbox - The bounding box [x1, y1, x2, y2].
     * @returns Array of points within the bounding box.
     */
    rangePoints(bbox: Bbox): Point[] {
        const tlCellX = this.coordToCellNum(bbox[0])
        const tlCellY = this.coordToCellNum(bbox[1])
        const brCellX = this.coordToCellNum(bbox[2])
        const brCellY = this.coordToCellNum(bbox[3])
        const points: Point[] = []

        for (let x = tlCellX; x <= brCellX; x++) {
            for (let y = tlCellY; y <= brCellY; y++) {
                const cellPoints = this.cellPoints(x, y)
                for (let i = 0; i < cellPoints.length; i++) {
                    points.push(cellPoints[i])
                }
            }
        }
    }

    /**
     * Removes a point from the grid.
     * @param point - The point [x, y].
     */
    removePoint(point: Point): void {
        const cellX = this.coordToCellNum(point[0])
        const cellY = this.coordToCellNum(point[1])
        const column = this._cells[cellX]
        if (!column || !column[cellY]) {
            return
        }
        const cell = column[cellY]!

        for (let i = 0; i < cell.length; i++) {
            if (cell[i][0] === point[0] && cell[i][1] === point[1]) {
                cell.splice(i, 1)
                break
            }
        }
    }

    /**
     * Extends a bounding box by a given scale factor.
     * @param bbox - The bounding box [x1, y1, x2, y2].
     * @param scaleFactor - The scale factor to apply.
     * @returns The extended bounding box.
     */
    extendBbox(bbox: Bbox, scaleFactor: number): Bbox {
        return [
            bbox[0] - (scaleFactor * this._cellSize),
            bbox[1] - (scaleFactor * this._cellSize),
            bbox[2] + (scaleFactor * this._cellSize),
            bbox[3] + (scaleFactor * this._cellSize)
        ]
    }
}

function _filterDuplicates(pointset: Point[]): Point[] {
    if (pointset.length === 0) {
        return []
    }
    const unique = [pointset[0]]
    let lastPoint = pointset[0]
    for (let i = 1; i < pointset.length; i++) {
        const currentPoint = pointset[i]
        if (lastPoint[0] !== currentPoint[0] || lastPoint[1] !== currentPoint[1]) {
            unique.push(currentPoint)
        }
        lastPoint = currentPoint
    }
    return unique
}

function _sortByX(pointset: Point[]): Point[] {
    return pointset.sort((a, b) => {
        return (a[0] - b[0]) || (a[1] - b[1])
    })
}

function _sqLength(a: Point, b: Point): number {
    return Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2)
}

function _cos(o: Point, a: Point, b: Point): number {
    const aShifted: Point = [a[0] - o[0], a[1] - o[1]]
    const bShifted: Point = [b[0] - o[0], b[1] - o[1]]
    const sqALen = _sqLength(o, a)
    const sqBLen = _sqLength(o, b)
    const dot = aShifted[0] * bShifted[0] + aShifted[1] * bShifted[1]

    return dot / Math.sqrt(sqALen * sqBLen)
}

function _segmentsCollinear(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
    for (let d = 0; d < 2; ++d) {
        const x0 = a0[d]
        const y0 = a1[d]
        const l0 = Math.min(x0, y0)
        const h0 = Math.max(x0, y0)

        const x1 = b0[d]
        const y1 = b1[d]
        const l1 = Math.min(x1, y1)
        const h1 = Math.max(x1, y1)

        if (h1 < l0 || h0 < l1) {
            return false
        }
    }

    return true
}

function _segmentsIntersect(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
    const x0 = orientation3(a0, b0, b1)
    const y0 = orientation3(a1, b0, b1)
    if ((x0 > 0 && y0 > 0) || (x0 < 0 && y0 < 0)) {
        return false
    }

    const x1 = orientation3(b0, a0, a1)
    const y1 = orientation3(b1, a0, a1)
    if ((x1 > 0 && y1 > 0) || (x1 < 0 && y1 < 0)) {
        return false
    }

    if (x0 === 0 && y0 === 0 && x1 === 0 && y1 === 0) {
        return _segmentsCollinear(a0, a1, b0, b1)
    }

    return true
}

function _intersect(segment: [Point, Point], pointset: Point[]): boolean {
    for (let i = 0; i < pointset.length - 1; i++) {
        const seg: [Point, Point] = [pointset[i], pointset[i + 1]]
        if (segment[0][0] === seg[0][0] && segment[0][1] === seg[0][1] ||
            segment[0][0] === seg[1][0] && segment[0][1] === seg[1][1]) {
            continue
        }
        if (_segmentsIntersect(segment[0], segment[1], seg[0], seg[1])) {
            return true
        }
    }
    return false
}

function _occupiedArea(pointset: Point[]): [number, number] {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (let i = pointset.length - 1; i >= 0; i--) {
        if (pointset[i][0] < minX) {
            minX = pointset[i][0]
        }
        if (pointset[i][1] < minY) {
            minY = pointset[i][1]
        }
        if (pointset[i][0] > maxX) {
            maxX = pointset[i][0]
        }
        if (pointset[i][1] > maxY) {
            maxY = pointset[i][1]
        }
    }

    return [
        maxX - minX, // width
        maxY - minY  // height
    ]
}

function _bBoxAround(edge: [Point, Point]): Bbox {
    return [
        Math.min(edge[0][0], edge[1][0]), // left
        Math.min(edge[0][1], edge[1][1]), // top
        Math.max(edge[0][0], edge[1][0]), // right
        Math.max(edge[0][1], edge[1][1])  // bottom
    ]
}

function _midPoint(edge: [Point, Point], innerPoints: Point[], convex: Point[]): Point | null {
    let point: Point | null = null
    let angle1Cos = MAX_CONCAVE_ANGLE_COS
    let angle2Cos = MAX_CONCAVE_ANGLE_COS
    let a1Cos: number
    let a2Cos: number

    for (let i = 0; i < innerPoints.length; i++) {
        a1Cos = _cos(edge[0], edge[1], innerPoints[i])
        a2Cos = _cos(edge[1], edge[0], innerPoints[i])

        if (a1Cos > angle1Cos && a2Cos > angle2Cos &&
            !_intersect([edge[0], innerPoints[i]], convex) &&
            !_intersect([edge[1], innerPoints[i]], convex)) {

            angle1Cos = a1Cos
            angle2Cos = a2Cos
            point = innerPoints[i]
        }
    }

    return point
}

function _concave(convex: Point[], maxSqEdgeLen: number, maxSearchArea: [number, number], gridInstance: PointGrid, edgeSkipList: Set<string>): Point[] {
    let midPointInserted = false

    for (let i = 0; i < convex.length - 1; i++) {
        const edge: [Point, Point] = [convex[i], convex[i + 1]]
        // generate a key in the format X0,Y0,X1,Y1
        const keyInSkipList = edge[0][0] + ',' + edge[0][1] + ',' + edge[1][0] + ',' + edge[1][1]

        if (_sqLength(edge[0], edge[1]) < maxSqEdgeLen ||
            edgeSkipList.has(keyInSkipList)) { continue }

        let scaleFactor = 0
        let bBoxAround = _bBoxAround(edge)
        let bBoxWidth: number
        let bBoxHeight: number
        let midPoint: Point | null
        do {
            bBoxAround = gridInstance.extendBbox(bBoxAround, scaleFactor)
            bBoxWidth = bBoxAround[2] - bBoxAround[0]
            bBoxHeight = bBoxAround[3] - bBoxAround[1]

            midPoint = _midPoint(edge, gridInstance.rangePoints(bBoxAround), convex)
            scaleFactor++
        }  while (midPoint === null && (maxSearchArea[0] > bBoxWidth || maxSearchArea[1] > bBoxHeight))

        if (bBoxWidth >= maxSearchArea[0] && bBoxHeight >= maxSearchArea[1]) {
            edgeSkipList.add(keyInSkipList)
        }

        if (midPoint !== null) {
            convex.splice(i + 1, 0, midPoint)
            gridInstance.removePoint(midPoint)
            midPointInserted = true
        }
    }

    if (midPointInserted) {
        return _concave(convex, maxSqEdgeLen, maxSearchArea, gridInstance, edgeSkipList)
    }

    return convex
}

function _convexHullIndices(points: Point[]): number[] {
    const n = points.length

    if (n < 3) {
        const result = new Array<number>(n)
        for (let i = 0; i < n; ++i) {
            result[i] = i
        }
        if (n === 2 &&
            points[0][0] === points[1][0] &&
            points[0][1] === points[1][1]) {
            return [0]
        }
        return result
    }

    const sorted = new Array<number>(n)
    for (let i = 0; i < n; ++i) {
        sorted[i] = i
    }
    sorted.sort((a, b) => {
        const d = points[a][0] - points[b][0]
        if (d) {
            return d
        }
        return points[a][1] - points[b][1]
    })

    const lower: number[] = [sorted[0], sorted[1]]
    const upper: number[] = [sorted[0], sorted[1]]

    for (let i = 2; i < n; ++i) {
        const idx = sorted[i]
        const p = points[idx]

        let m = lower.length
        while (m > 1 && orientation3(points[lower[m - 2]], points[lower[m - 1]], p) <= 0) {
            m -= 1
            lower.pop()
        }
        lower.push(idx)

        m = upper.length
        while (m > 1 && orientation3(points[upper[m - 2]], points[upper[m - 1]], p) >= 0) {
            m -= 1
            upper.pop()
        }
        upper.push(idx)
    }

    const result = new Array<number>(upper.length + lower.length - 2)
    let ptr = 0
    for (let i = 0, nl = lower.length; i < nl; ++i) {
        result[ptr++] = lower[i]
    }
    for (let j = upper.length - 2; j > 0; --j) {
        result[ptr++] = upper[j]
    }

    return result
}

/**
 * Builds a concave hull from a set of points.
 * @param pointset - The set of points [x, y].
 * @param concavity - The concavity of the hull.
 * @returns The concave hull (first point repeated).
 */
export default function hull(pointset: Point[], concavity?: number): Point[] {
    if (pointset.length === 0) {
        return []
    }

    const maxEdgeLen = concavity || 20

    const points = _filterDuplicates(_sortByX(pointset.slice()))

    if (points.length < 4) {
        return points.concat([points[0]])
    }

    const occupiedArea = _occupiedArea(points)
    const maxSearchArea: [number, number] = [
        occupiedArea[0] * MAX_SEARCH_BBOX_SIZE_PERCENT,
        occupiedArea[1] * MAX_SEARCH_BBOX_SIZE_PERCENT
    ]

    const convex = _convexHullIndices(points).reverse().map(idx => points[idx]) // ccw -> cw, indices -> points
    convex.push(convex[0])

    const innerPoints = points.filter((pt) => {
        return convex.indexOf(pt) < 0
    })

    const cellSize = Math.ceil(1 / (points.length / (occupiedArea[0] * occupiedArea[1])))

    const concave = _concave(
        convex, Math.pow(maxEdgeLen, 2),
        maxSearchArea, new PointGrid(innerPoints, cellSize), new Set())

    return concave
}

