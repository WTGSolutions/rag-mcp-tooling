#include <string>
#include <cmath>

namespace geo {

// A point in 2D space.
struct Point {
  double x;
  double y;
  double dist() const;
};

// Out-of-line definition of a struct method.
double Point::dist() const {
  return std::sqrt(x * x + y * y);
}

// A drawable shape with a polygon side count.
class Shape {
public:
  Shape(int sides) : sides_(sides) {}
  ~Shape() {}
  int sides() const { return sides_; }
  virtual double area() const;

private:
  int sides_;
};

// Out-of-line virtual method definition.
double Shape::area() const {
  return 0.0;
}

}  // namespace geo

// A free function adding two integers.
int add(int a, int b) {
  return a + b;
}

// Returns a heap pointer (pointer-declarator wraps the function declarator).
int* makeBuffer(int n) {
  return new int[n];
}

// A generic max over any comparable type.
template <typename T>
T maxOf(T a, T b) {
  return a > b ? a : b;
}

enum Color { Red, Green, Blue };

// A tagged value (union with an inline accessor).
union Value {
  int i;
  float f;
  int asInt() const { return i; }
};

// C linkage block — common in headers shared with C.
extern "C" {

// Initialises the C API.
int c_api_init(int flags) {
  return flags;
}

}  // extern "C"
