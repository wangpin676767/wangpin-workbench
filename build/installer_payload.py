"""Read offline ZIP bounds from unsigned or Authenticode-appended PE files.

Certificate structure validation is not cryptographic signature verification.
"""
import struct


def payload_bounds(data):
    def read(fmt, offset):
        size = struct.calcsize(fmt)
        if offset < 0 or offset + size > len(data):
            raise ValueError('Header outside file')
        return struct.unpack_from(fmt, data, offset)[0]

    if len(data) < 64 or data[:2] != b'MZ':
        raise ValueError('Invalid DOS header')
    pe = read('<I', 0x3c)
    if pe < 64 or pe > len(data) - 24 or data[pe:pe + 4] != b'PE\0\0':
        raise ValueError('Invalid PE header')
    optional = pe + 24
    optional_size = read('<H', pe + 20)
    if optional_size < 2 or optional + optional_size > len(data):
        raise ValueError('Invalid optional header')
    directory = {0x20b: 112, 0x10b: 96}.get(read('<H', optional))
    if directory is None or optional_size < directory + 40 or read('<I', optional + directory - 4) < 5:
        raise ValueError('Invalid security directory')
    certificate = read('<I', optional + directory + 32)
    size = read('<I', optional + directory + 36)
    end = len(data)
    if certificate or size:
        if certificate < optional + optional_size or certificate % 8 or size < 8 or certificate + size != len(data):
            raise ValueError('Invalid certificate bounds')
        cursor = certificate
        while cursor < len(data):
            length = read('<I', cursor)
            if length < 8 or cursor + length > len(data) or read('<H', cursor + 4) != 0x200 or read('<H', cursor + 6) != 2:
                raise ValueError('Invalid certificate entry')
            cursor += (length + 7) & ~7
        if cursor != len(data):
            raise ValueError('Invalid certificate alignment')
        end = certificate
    for padding in range(8):
        trailer = end - padding - 16
        if trailer < 0 or data[trailer + 8:trailer + 16] != b'CMZIP170':
            continue
        offset = read('<q', trailer)
        if not 0 < offset < trailer or any(data[end - padding:end]):
            raise ValueError('Invalid payload offset or signing padding')
        return offset, trailer
    raise ValueError('Missing payload trailer')
