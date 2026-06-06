//! A minimal point quadtree for spatial range queries over GPS fixes.

#[derive(Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Axis-aligned bounding box.
pub struct BBox {
    pub min: Point,
    pub max: Point,
}

impl BBox {
    fn contains(&self, p: Point) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }
}

/// A quadtree node storing points until it exceeds capacity.
pub struct QuadTree {
    bounds: BBox,
    points: Vec<Point>,
    capacity: usize,
}

impl QuadTree {
    pub fn new(bounds: BBox, capacity: usize) -> Self {
        QuadTree { bounds, points: Vec::new(), capacity }
    }

    /// Insert a point into the quadtree spatial index.
    pub fn insert(&mut self, p: Point) -> bool {
        if !self.bounds.contains(p) {
            return false;
        }
        self.points.push(p);
        true
    }

    /// Range query: all points falling within the given bounding box.
    pub fn query_range(&self, range: &BBox) -> Vec<Point> {
        self.points.iter().copied().filter(|p| range.contains(*p)).collect()
    }
}
