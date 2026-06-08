import Foundation

struct User: Codable, Identifiable, Sendable {
    let id: Int
    let email: String
    let phone: String?
    let displayName: String?

    enum CodingKeys: String, CodingKey {
        case id, email, phone
        case displayName = "display_name"
    }
}
