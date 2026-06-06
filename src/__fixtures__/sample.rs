//! Sample crate for Rust chunking.

const VERSION: &str = "1.0";

/// Adds two numbers.
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// A 2D point.
pub struct Point {
    x: i32,
    y: i32,
}

pub enum Direction {
    North,
    South,
}

/// Shapes have an area.
pub trait Shape {
    fn area(&self) -> f64;
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }

    fn magnitude(&self) -> f64 {
        0.0
    }
}

impl Shape for Point {
    fn area(&self) -> f64 {
        1.0
    }
}
