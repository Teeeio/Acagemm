def get_inputs():
    return {
        "left": [1.0, 2.0, 3.0, 4.0],
        "right": [10.0, 20.0, 30.0, 40.0],
    }


def run(inputs):
    return [a + b for a, b in zip(inputs["left"], inputs["right"])]


def reference(inputs):
    return [a + b for a, b in zip(inputs["left"], inputs["right"])]
