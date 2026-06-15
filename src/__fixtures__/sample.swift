import Foundation

// A 2D point.
struct Point {
    let x: Double
    let y: Double

    func dist() -> Double {
        return (x * x + y * y).squareRoot()
    }
}

// A view controller.
class ViewController: UIViewController {
    func viewDidLoad() {
        setup()
    }

    private func setup() {}
}

// A request handler contract.
protocol Service {
    func handle(_ req: Request) -> Response
}

// Named colors.
enum Color {
    case red, green, blue

    func hex() -> String {
        return ""
    }
}

// Extension adding a computed helper.
extension Point {
    func magnitude() -> Double {
        return dist()
    }
}

// A bank account with lifecycle hooks.
class Account {
    private var balance: Int

    init(balance: Int) {
        self.balance = balance
    }

    deinit {
        balance = 0
    }

    func deposit(_ amount: Int) {
        balance += amount
    }
}

// An actor serialising access to a counter.
actor Counter {
    private var value = 0

    func increment() {
        value += 1
    }
}

// A free top-level function.
func topLevel(_ n: Int) -> Int {
    return n * 2
}
