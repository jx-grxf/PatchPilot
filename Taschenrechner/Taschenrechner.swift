import Foundation

// MARK: - Calculator

enum Operation {
    case add, subtract, multiply, divide
}

struct Calculator {
    private var memory: Double = 0

    mutating func add(_ value: Double) -> Double {
        memory += value
        return memory
    }

    mutating func subtract(_ value: Double) -> Double {
        memory -= value
        return memory
    }

    mutating func multiply(_ value: Double) -> Double {
        memory *= value
        return memory
    }

    mutating func divide(_ value: Double) -> Double {
        guard value != 0 else {
            print("⚠️  Division durch Null ist nicht erlaubt!")
            return memory
        }
        memory /= value
        return memory
    }

    mutating func clear() {
        memory = 0
    }

    var result: Double { memory }
}

// MARK: - CLI Interface

func runCalculator() {
    var calc = Calculator()
    print("🧮 Swift Taschenrechner")
    print("Befehle: add, sub, mul, div, clear, quit")
    print("Beispiel: add 5 → sub 3 → result\n")

    while true {
        print("📝 Eingabe: ", terminator: "")
        guard let input = readLine() else { break }

        let parts = input.trimmingCharacters(in: .whitespaces).split(separator: " ").map(String.init)
        guard !parts.isEmpty else { continue }

        let command = parts[0].lowercased()
        let value: Double? = parts.count > 1 ? Double(parts[1]) : nil

        switch command {
        case "add":
            guard let v = value else { print("❌ Bitte einen Wert angeben."); continue }
            _ = calc.add(v)
        case "sub":
            guard let v = value else { print("❌ Bitte einen Wert angeben."); continue }
            _ = calc.subtract(v)
        case "mul":
            guard let v = value else { print("❌ Bitte einen Wert angeben."); continue }
            _ = calc.multiply(v)
        case "div":
            guard let v = value else { print("❌ Bitte einen Wert angeben."); continue }
            _ = calc.divide(v)
        case "clear":
            calc.clear()
            print("✅ Speicher gelöscht.")
        case "result", "r":
            print("📊 Ergebnis: \(calc.result)")
        case "quit", "exit":
            print("👋 Auf Wiedersehen!")
            break
        default:
            print("❓ Unbekannter Befehl. Versuche: add, sub, mul, div, clear, result, quit")
        }
    }
}

// Starte den Taschenrechner
runCalculator()
