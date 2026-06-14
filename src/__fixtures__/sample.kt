package com.example.geo

import kotlin.math.sqrt

// A 2D point.
data class Point(val x: Double, val y: Double) {
    fun dist(): Double = sqrt(x * x + y * y)
}

// Repository over a backing store.
class Repository(private val db: Db) {
    fun findById(id: String): Item? {
        return db.get(id)
    }

    fun save(item: Item) {
        db.put(item.id, item)
    }
}

// A request handler contract.
interface Service {
    fun handle(req: Request): Response
}

// A process-wide singleton.
object Singleton {
    fun init() {}
}

enum class Color { RED, GREEN, BLUE }

// A free top-level function.
fun topLevel(n: Int): Int = n * 2
